import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Symbol } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import type { Candle } from "../types/index.js";
import { DCA, dcaNetR } from "./dca.js";
import { EXPIRY_MS, expiryBarsFor, netR, returnPercent, stepBar, tickExit, type ExitResult, type Position } from "./engine.js";
import { emptyGrid, GRID, stepGrid, type GridState } from "./grid.js";
import type { StrategySignal, StrategySignalStore } from "./signalStore.js";
import { TIMEFRAME_MS, type ExitReason, type Strategy, type StrategyTimeframe } from "./types.js";

/** What happens to a signal once it has entered. Only validated signals ever reach these hooks. */
export interface RouteHooks {
  onValidatedSignal(signal: StrategySignal): void;
  onValidatedClosed(signal: StrategySignal): void;
}

export interface GeneratorDeps {
  strategies: readonly Strategy[];
  store: StrategySignalStore;
  /** strategyPassed: true only for a saved PASSED backtest result of this strategy, symbol and timeframe. */
  passed: (strategyId: string, symbol: string, timeframe: string) => boolean;
  hooks: RouteHooks;
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
  /** Where the newest processed candle per symbol and timeframe (and the grids) are kept, so a restart never repeats work. */
  stateFile?: string;
  now?: () => number;
}

interface State {
  /** Open time of the newest closed candle already processed, per `symbol:timeframe`. */
  last: Record<string, number>;
  /** The grid of each symbol, and the newest candle it has seen. */
  grids: Record<string, { state: GridState; last: number }>;
}

/** Candles that must be loaded for the indicators of any strategy in the library. */
export const CANDLES_NEEDED = 300;

export interface GeneratorResult {
  created: StrategySignal[];
  entered: StrategySignal[];
  closed: StrategySignal[];
}

/**
 * Runs every strategy of the library, each on its own timeframe, on every newly closed candle.
 *  - A signal is made on the close of a candle and enters at the open of the next one.
 *  - One open signal per strategy per symbol (GridTrading is exempt: up to 5 grid positions; DcaAccumulator follows another
 *    strategy's buy).
 *  - A signal's id is built from the strategy, the symbol and the candle, so a candle is never turned into a signal twice.
 *  - Any open signal is closed at market after 24 hours if no level was hit.
 *  - A signal is validated only if its strategy PASSED its backtest. Validated signals go to the hooks (Telegram, demo) when
 *    they enter; every other signal is stored as research only and goes nowhere else.
 */
export class StrategySignalGenerator {
  private state: State;
  private readonly now: () => number;

  constructor(private readonly d: GeneratorDeps) {
    this.now = d.now ?? Date.now;
    this.state = this.loadState();
  }

  /**
   * One symbol and timeframe. `candles` holds the closed candles and, if there is one, the forming candle (its open is the
   * entry price of a signal made on the previous close).
   */
  processCandles(symbol: Symbol, timeframe: StrategyTimeframe, candles: Candle[]): GeneratorResult {
    const result: GeneratorResult = { created: [], entered: [], closed: [] };
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const closed = sorted.filter((c) => c.closed);
    const forming = sorted.filter((c) => !c.closed).at(-1);
    const last = closed.at(-1);
    if (!last) return result;
    const key = `${symbol}:${timeframe}`;
    const fresh = this.state.last[key] === undefined || last.time > this.state.last[key]!;
    const tfMs = TIMEFRAME_MS[timeframe];

    for (const strategy of this.d.strategies.filter((s) => s.timeframe === timeframe && s.kind === "standard")) {
      if (closed.length < strategy.warmup + 2) continue;
      try {
        const inst = strategy.create(closed, { symbol, log: (m) => this.d.logger.info({ strategyId: strategy.id, symbol }, m) });
        const indexOf = (time: number) => closed.findIndex((c) => c.time === time);

        // a) a pending signal enters at the open of the candle after its signal candle
        const pending = this.d.store.activeFor(strategy.id, symbol);
        if (pending?.status === "PENDING") this.enter(pending, inst.plan(indexOf(pending.candleTime)), closed, forming, tfMs, result);

        // b) an open signal meets the candles it has not seen yet
        const open = this.d.store.activeFor(strategy.id, symbol);
        if (open?.status === "OPEN" && fresh) {
          const signalIndex = indexOf(open.candleTime);
          const plan = signalIndex >= 0 ? inst.plan(signalIndex) : null;
          const pos = this.position(open, plan?.maxBars, strategy.timeframe);
          for (let j = Math.max(0, signalIndex + 1); j < closed.length; j++) {
            const c = closed[j]!;
            if (c.time <= open.lastCheckedCandle) continue;
            open.lastCheckedCandle = c.time;
            const exit = stepBar(pos, c, j - signalIndex, () => plan?.onClose?.(j, { entry: open.entry, stop: pos.stop, entryIndex: signalIndex + 1 }) ?? null);
            if (exit) {
              result.closed.push(this.close(open, exit, c.time + tfMs));
              break;
            }
          }
          if (open.status === "OPEN") {
            if (pos.stop !== open.stopLoss) open.trailStop = pos.stop;
            this.d.store.update(open);
          }
        }

        // c) a new signal, only if this strategy has none pending or open on this symbol
        if (fresh && !this.d.store.activeFor(strategy.id, symbol)) {
          const plan = inst.signal(closed.length - 1);
          if (plan) {
            const signal = this.create(strategy, symbol, last, plan.note);
            if (signal) {
              result.created.push(signal);
              this.enter(signal, plan, closed, forming, tfMs, result); // enters at once if the next candle has already opened
            }
          }
        }
      } catch (err) {
        this.d.logger.error({ err, strategyId: strategy.id, symbol }, "strategy failed on a candle");
      }
    }

    if (fresh && timeframe === "1h") {
      this.followWithDca(symbol, forming ? [...closed, forming] : closed, tfMs, result); // a part is bought at a candle's OPEN, so the forming candle counts
    }
    if (timeframe === "1h" && this.d.strategies.some((s) => s.kind === "grid")) this.runGrid(symbol, closed, tfMs, result);

    if (fresh) this.setDone(key, last.time);
    return result;
  }

  /** A live price: a stop or target can be hit between candles, and an entered signal older than 24 hours is closed at market. */
  onTick(symbol: string, price: number, at: number): StrategySignal[] {
    const closed: StrategySignal[] = [];
    for (const signal of this.d.store.open(symbol)) {
      if (signal.strategyId === "GridTrading" || signal.strategyId === "DcaAccumulator") continue; // these follow candles and their parent
      const stop = signal.trailStop ?? signal.stopLoss;
      const exit: ExitResult | null = tickExit({ stop, target: signal.targets[0] }, price) ?? (at - signal.createdAt >= EXPIRY_MS ? { reason: "EXPIRED", price } : null);
      if (exit) closed.push(this.close(signal, exit, at));
    }
    return closed;
  }

  // -------------------------------------------------------------------------------------------------------------------

  private position(s: StrategySignal, maxBars: number | undefined, tf: StrategyTimeframe): Position {
    return { entry: s.entry, stop: s.trailStop ?? s.stopLoss, target: s.targets[0], maxBars, expiryBars: expiryBarsFor(tf) };
  }

  /** A PENDING signal (made on a closed candle). */
  private create(strategy: Strategy, symbol: string, signalCandle: Candle, note?: string): StrategySignal | null {
    const id = `${strategy.id}:${symbol}:${signalCandle.time}`;
    if (this.d.store.get(id)) return null; // never processed twice
    const validated = this.d.passed(strategy.id, symbol, strategy.timeframe);
    const signal: StrategySignal = {
      id,
      strategyId: strategy.id,
      symbol,
      timeframe: strategy.timeframe,
      direction: "BUY",
      entry: signalCandle.close,
      stopLoss: signalCandle.close,
      targets: [],
      createdAt: signalCandle.time + TIMEFRAME_MS[strategy.timeframe],
      candleTime: signalCandle.time,
      lastCheckedCandle: signalCandle.time,
      validated,
      researchOnly: !validated,
      ...(note ? { note } : {}),
      status: "PENDING",
    };
    this.d.store.add(signal);
    this.d.logger.info({ id, strategyId: strategy.id, symbol, validated }, validated ? "strategy signal made" : "strategy signal made (research only)");
    return signal;
  }

  /** The position enters at the open of the candle after the signal candle, if that candle exists yet. */
  private enter(signal: StrategySignal, plan: { levels(entry: number): { stopLoss: number; targets: number[] } } | null, closed: Candle[], forming: Candle | undefined, tfMs: number, result: GeneratorResult): void {
    const entryTime = signal.candleTime + tfMs;
    const entryCandle = closed.find((c) => c.time === entryTime) ?? (forming?.time === entryTime ? forming : undefined);
    if (!entryCandle) return; // the next candle has not opened yet: it enters later
    if (!plan) {
      this.cancel(signal, entryTime);
      return;
    }
    const entry = entryCandle.open;
    const levels = plan.levels(entry);
    if (!(levels.stopLoss < entry)) {
      this.cancel(signal, entryTime); // the stop is not below the entry price: no trade
      return;
    }
    const [t1, t2, t3] = levels.targets.length === 1 ? [levels.targets[0], levels.targets[0], levels.targets[0]] : levels.targets;
    Object.assign(signal, {
      entry,
      stopLoss: levels.stopLoss,
      targets: levels.targets,
      ...(t1 !== undefined ? { tp1: t1, tp2: t2, tp3: t3 } : {}),
      status: "OPEN",
      filledAt: entryTime,
    });
    this.d.store.update(signal);
    result.entered.push(signal);
    this.d.logger.info({ id: signal.id, entry, stop: levels.stopLoss }, "strategy signal entered");
    if (signal.validated) this.d.hooks.onValidatedSignal(signal);
  }

  private cancel(signal: StrategySignal, at: number): void {
    signal.status = "CLOSED";
    signal.outcome = { reason: "CANCELLED", exitPrice: signal.entry, closedAt: at, returnPercent: 0, netR: 0 };
    this.d.store.update(signal);
    this.d.logger.info({ id: signal.id }, "strategy signal cancelled: no valid entry");
  }

  private close(signal: StrategySignal, exit: ExitResult, at: number): StrategySignal {
    signal.status = "CLOSED";
    signal.outcome = {
      reason: exit.reason,
      exitPrice: exit.price,
      closedAt: at,
      returnPercent: Math.round(returnPercent(signal.entry, exit.price) * 100) / 100,
      netR: Math.round(netR(signal.entry, signal.stopLoss, exit.price) * 100) / 100,
    };
    this.d.store.update(signal);
    this.d.logger.info({ id: signal.id, reason: exit.reason, netR: signal.outcome.netR }, "strategy signal closed");
    if (signal.validated) this.d.hooks.onValidatedClosed(signal);
    return signal;
  }

  // ---- GridTrading ---------------------------------------------------------------------------------------------------

  /** The grid steps through each new closed candle; every fill is a signal and every sale or exit closes one. */
  private runGrid(symbol: Symbol, closed: Candle[], tfMs: number, result: GeneratorResult): void {
    const grid = this.d.strategies.find((s) => s.kind === "grid");
    if (!grid) return;
    const entry = this.state.grids[symbol] ?? { state: emptyGrid(), last: -1 };
    // the first time, the grid is set up from the newest candle only (history is not replayed)
    const fresh = entry.last < 0 ? closed.slice(-1) : closed.filter((c) => c.time > entry.last);
    for (const c of fresh) {
      const upTo = closed.slice(0, closed.indexOf(c) + 1);
      for (const e of stepGrid(entry.state, c, upTo.slice(-GRID.lookback), tfMs, `${grid.id}:${symbol}`)) {
        if (e.type === "fill") {
          const p = e.position;
          const validated = this.d.passed(grid.id, symbol, grid.timeframe);
          const signal: StrategySignal = {
            id: p.id, strategyId: grid.id, symbol, timeframe: grid.timeframe, direction: "BUY",
            entry: p.fillPrice, stopLoss: p.stopRef, targets: [p.sellLevel], tp1: p.sellLevel, tp2: p.sellLevel, tp3: p.sellLevel,
            createdAt: p.fillTime, candleTime: c.time, lastCheckedCandle: c.time, filledAt: c.time,
            validated, researchOnly: !validated, status: "OPEN",
          };
          this.d.store.add(signal);
          result.created.push(signal);
          result.entered.push(signal);
          if (validated) this.d.hooks.onValidatedSignal(signal);
        } else {
          const signal = this.d.store.get(e.position.id);
          if (signal?.status === "OPEN") result.closed.push(this.close(signal, { reason: e.reason as ExitReason, price: e.price }, e.time));
        }
      }
      entry.last = c.time;
    }
    this.state.grids[symbol] = entry;
    this.save();
  }

  // ---- DcaAccumulator ------------------------------------------------------------------------------------------------

  /** DcaAccumulator never makes its own entries: it follows another 1h strategy's entered buy, one at a time per symbol. */
  private followWithDca(symbol: Symbol, candles: Candle[], tfMs: number, result: GeneratorResult): void {
    const dca = this.d.strategies.find((s) => s.kind === "dca");
    if (!dca) return;
    const validated = this.d.passed(dca.id, symbol, dca.timeframe);
    const active = this.d.store.active(symbol).filter((s) => s.strategyId === dca.id);

    // a new follower for an entered parent, if no DCA position is open on this symbol
    if (active.length === 0) {
      const parent = this.d.store.open(symbol).find((s) => s.timeframe === "1h" && s.strategyId !== dca.id && s.strategyId !== "GridTrading" && !this.d.store.get(`${dca.id}:${symbol}:${s.id}`));
      if (parent && parent.filledAt !== undefined) {
        const signal: StrategySignal = {
          id: `${dca.id}:${symbol}:${parent.id}`, strategyId: dca.id, symbol, timeframe: dca.timeframe, direction: "BUY",
          entry: parent.entry, stopLoss: parent.stopLoss, targets: parent.targets,
          ...(parent.tp1 !== undefined ? { tp1: parent.tp1, tp2: parent.tp2, tp3: parent.tp3 } : {}),
          createdAt: parent.createdAt, candleTime: parent.candleTime, lastCheckedCandle: parent.filledAt, filledAt: parent.filledAt,
          validated, researchOnly: !validated, status: "OPEN", parentId: parent.id,
          dca: { fills: [{ time: parent.filledAt, price: parent.entry, weight: DCA.firstShare }], cancelled: false },
        };
        this.d.store.add(signal);
        result.created.push(signal);
        result.entered.push(signal);
        active.push(signal);
        if (validated) this.d.hooks.onValidatedSignal(signal);
      }
    }

    for (const s of active) {
      const parent = s.parentId ? this.d.store.get(s.parentId) : undefined;
      const entryTime = (parent?.filledAt ?? s.filledAt)!;
      const parentGone = parent?.status === "CLOSED" ? (parent.outcome?.closedAt ?? Infinity) - tfMs : Infinity; // open time of the candle it left in
      // the six hourly parts: at the open of each of the next 6 candles that the parent is still open for
      if (s.dca && !s.dca.cancelled) {
        for (const c of candles) {
          const k = Math.round((c.time - entryTime) / tfMs);
          if (c.time <= s.lastCheckedCandle || k < 1 || k > DCA.parts || c.time > parentGone) continue;
          if (c.open > s.entry * (1 + DCA.maxAboveFirstEntryPercent / 100)) s.dca.cancelled = true;
          else s.dca.fills.push({ time: c.time, price: c.open, weight: DCA.partShare });
          if (s.dca.cancelled) break;
        }
      }
      s.lastCheckedCandle = candles.at(-1)!.time;
      if (parent?.status === "CLOSED" && parent.outcome && s.dca) {
        if (parent.outcome.reason === "CANCELLED") {
          s.status = "CLOSED";
          s.outcome = { reason: "CANCELLED", exitPrice: s.entry, closedAt: parent.outcome.closedAt, returnPercent: 0, netR: 0 };
        } else {
          const weight = s.dca.fills.reduce((a, f) => a + f.weight, 0);
          const averageEntry = s.dca.fills.reduce((a, f) => a + f.weight * f.price, 0) / weight;
          s.status = "CLOSED";
          s.outcome = {
            reason: parent.outcome.reason,
            exitPrice: parent.outcome.exitPrice,
            closedAt: parent.outcome.closedAt,
            returnPercent: Math.round(returnPercent(averageEntry, parent.outcome.exitPrice) * 100) / 100,
            netR: Math.round(dcaNetR(s.dca.fills, parent.outcome.exitPrice, s.stopLoss, s.entry) * 100) / 100,
          };
          result.closed.push(s);
          if (s.validated) this.d.hooks.onValidatedClosed(s);
        }
      }
      this.d.store.update(s);
    }
  }

  // ---- state ---------------------------------------------------------------------------------------------------------

  private setDone(key: string, time: number): void {
    this.state.last[key] = time;
    this.save();
  }

  private save(): void {
    if (!this.d.stateFile) return;
    try {
      mkdirSync(dirname(this.d.stateFile), { recursive: true });
      writeFileSync(`${this.d.stateFile}.tmp`, JSON.stringify(this.state));
      renameSync(`${this.d.stateFile}.tmp`, this.d.stateFile);
    } catch (err) {
      this.d.logger.error({ err }, "could not save the strategy runner state");
    }
  }

  private loadState(): State {
    const fresh: State = { last: {}, grids: {} };
    try {
      if (!this.d.stateFile || !existsSync(this.d.stateFile)) return fresh;
      const raw = JSON.parse(readFileSync(this.d.stateFile, "utf8")) as Partial<State>;
      return { last: raw.last && typeof raw.last === "object" ? raw.last : {}, grids: raw.grids && typeof raw.grids === "object" ? raw.grids : {} };
    } catch {
      return fresh;
    }
  }
}

export interface StrategyRunnerDeps {
  generator: StrategySignalGenerator;
  strategies: readonly Strategy[];
  symbols: () => Symbol[];
  market: { getFreshCandles(symbol: Symbol, interval: StrategyTimeframe, limit: number): Promise<Candle[]> };
  logger: Pick<Logger, "warn">;
  tickMs?: number;
}

/** Wakes every 30 seconds and hands the candles of each symbol and timeframe to the generator. */
export class StrategyRunner {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly d: StrategyRunnerDeps) {}

  start(): void {
    const run = () => void this.tick();
    this.timer = setInterval(run, this.d.tickMs ?? 30_000);
    this.timer.unref();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const timeframes = [...new Set(this.d.strategies.map((s) => s.timeframe))];
      for (const symbol of this.d.symbols()) {
        for (const tf of timeframes) {
          try {
            this.d.generator.processCandles(symbol, tf, await this.d.market.getFreshCandles(symbol, tf, CANDLES_NEEDED));
          } catch (err) {
            this.d.logger.warn({ err: err instanceof Error ? err.message : String(err), symbol, tf }, "strategy runner step failed");
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

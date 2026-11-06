import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSymbol, type Symbol } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import type { SignalSettingsProvider } from "../signals/settingsProvider.js";
import type { Candle, Signal } from "../types/index.js";

export const RUNNER_TIMEFRAMES = ["1h"] as const;
export const STALE_AFTER_MS = 5 * 60_000;
const MAX_EVENTS = 20;

export interface RunnerEvent {
  at: string;
  type: "baseline" | "evaluated" | "signal" | "error" | "restart";
  symbol?: string;
  detail: string;
}

export interface SignalRunnerDeps {
  service: {
    processHour(symbol: Symbol, rethrow?: boolean): Promise<Signal | null>;
    checkPrice(symbol: Symbol, price: number, at: number): void;
  };
  market: { getFreshCandles(symbol: Symbol, interval: "1h", limit: number): Promise<Candle[]> };
  /** Latest known price candle per symbol (the 5-second poller). Optional. */
  prices?: { getLatest(symbol: string): Candle | undefined };
  settings: SignalSettingsProvider;
  logger: Logger;
  /** Where the last processed candle per symbol and timeframe is kept, so a restart never repeats work. */
  stateFile: string;
  now?: () => number;
  /** How often to look for a newly closed candle. Default 30 s. */
  tickMs?: number;
  /** How often to check the live price against running signals. Default 60 s. */
  priceMs?: number;
  /** Any single market call or evaluation that takes longer than this is abandoned. Default 30 s. */
  callTimeoutMs?: number;
  /** Creation time of the newest stored signal, for /health after a restart. */
  lastSignalAt?: number | null;
}

type State = Record<string, number>;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs the signal engine on the server alone, 24/7. It wakes every 30 seconds, and for each enabled symbol looks at
 * the newest CLOSED 1H candle (the forming one is never used). A candle it has not processed yet is evaluated once;
 * the candle time is saved in runner-state.json so a restart or a network drop neither repeats nor skips work.
 */
export class SignalRunner {
  private readonly now: () => number;
  private state: State;
  private gen = 0;
  private running = false;
  private tickTimer?: NodeJS.Timeout;
  private priceTimer?: NodeJS.Timeout;
  private lastTickAt = 0;
  private readonly lastCandle: Record<string, number> = {};
  private lastSignalAt: number | null = null;
  private readonly log: RunnerEvent[] = [];

  constructor(private readonly d: SignalRunnerDeps) {
    this.now = d.now ?? Date.now;
    this.state = this.loadState();
    this.lastSignalAt = d.lastSignalAt ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickAt = this.now();
    const gen = ++this.gen;
    const loop = async () => {
      if (!this.running || gen !== this.gen) return;
      try {
        await this.tick();
      } catch (err) {
        this.fail("tick", err);
      }
      if (this.running && gen === this.gen) {
        this.tickTimer = setTimeout(() => void loop(), this.d.tickMs ?? 30_000);
        this.tickTimer.unref?.();
      }
    };
    void loop();
    this.priceTimer = setInterval(() => this.priceCheck(), this.d.priceMs ?? 60_000);
    this.priceTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    this.gen++;
    clearTimeout(this.tickTimer);
    clearInterval(this.priceTimer);
  }

  /** Stops the loop (even one stuck on a hung call) and starts a fresh one. State on disk is kept. */
  restart(reason: string): void {
    this.stop();
    this.record({ type: "restart", detail: reason });
    this.d.logger.warn({ reason }, "signal runner restarted");
    this.start();
  }

  /** Last time the loop completed a pass (used by the watchdog). */
  lastActivity(): number {
    return this.lastTickAt;
  }

  /** "running" while the loop completes a pass at least every 5 minutes. */
  runnerStatus(): "running" | "stale" {
    return this.running && this.now() - this.lastTickAt <= STALE_AFTER_MS ? "running" : "stale";
  }

  lastCandleTimes(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [symbol, t] of Object.entries(this.lastCandle)) out[symbol] = new Date(t).toISOString();
    return out;
  }

  lastSignalTime(): string | null {
    return this.lastSignalAt ? new Date(this.lastSignalAt).toISOString() : null;
  }

  events(): RunnerEvent[] {
    return [...this.log];
  }

  /** One pass over the enabled symbols. Errors are caught per symbol so one failure never blocks the others. */
  async tick(): Promise<void> {
    const gen = this.gen;
    const s = this.d.settings.get();
    if (s.enabled) {
      for (const symbol of s.enabledSymbols) {
        if (!isSymbol(symbol)) continue;
        try {
          await this.runSymbol(symbol);
        } catch (err) {
          this.fail(symbol, err);
        }
        if (gen !== this.gen) return; // restarted while waiting: this loop is obsolete
      }
    }
    if (gen === this.gen) this.lastTickAt = this.now();
  }

  /** Checks the newest known price of each enabled symbol against the stops and targets of running signals. */
  priceCheck(): void {
    try {
      const s = this.d.settings.get();
      if (!s.enabled) return;
      for (const symbol of s.enabledSymbols) {
        const candle = this.d.prices?.getLatest(symbol);
        if (candle && isSymbol(symbol)) this.d.service.checkPrice(symbol, candle.close, this.now());
      }
    } catch (err) {
      this.fail("price check", err);
    }
  }

  private async runSymbol(symbol: Symbol): Promise<void> {
    const timeout = this.d.callTimeoutMs ?? 30_000;
    for (const timeframe of RUNNER_TIMEFRAMES) {
      const candles = await withTimeout(this.d.market.getFreshCandles(symbol, timeframe, 3), timeout, `${symbol} ${timeframe} candles`);
      const last = candles.filter((c) => c.closed).sort((a, b) => a.time - b.time).at(-1); // never the forming candle
      if (!last) continue;
      this.lastCandle[symbol] = last.time;
      const key = `${symbol}:${timeframe}`;
      const done = this.state[key];
      if (done === undefined) {
        // First run ever for this symbol: remember where we are, do not act on an old candle.
        this.setDone(key, last.time);
        this.record({ type: "baseline", symbol, detail: `starting after ${new Date(last.time).toISOString()}` });
        continue;
      }
      if (last.time <= done) continue; // already processed
      const signal = await withTimeout(this.d.service.processHour(symbol, true), timeout, `${symbol} evaluation`);
      this.setDone(key, last.time); // only after a successful evaluation, so a failure is retried on the next pass
      if (signal) {
        this.lastSignalAt = this.now();
        this.record({ type: "signal", symbol, detail: `${signal.side} ${signal.id} score ${signal.score}` });
      } else {
        this.record({ type: "evaluated", symbol, detail: `candle ${new Date(last.time).toISOString()}: no signal` });
      }
    }
  }

  private fail(what: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.d.logger.warn({ what, err: message }, "signal runner step failed");
    this.record({ type: "error", symbol: isSymbol(what) ? what : undefined, detail: `${what}: ${message}` });
  }

  private record(e: Omit<RunnerEvent, "at">): void {
    this.log.push({ at: new Date(this.now()).toISOString(), ...e });
    if (this.log.length > MAX_EVENTS) this.log.shift();
  }

  private setDone(key: string, time: number): void {
    this.state[key] = time;
    try {
      mkdirSync(dirname(this.d.stateFile), { recursive: true });
      writeFileSync(`${this.d.stateFile}.tmp`, JSON.stringify(this.state));
      renameSync(`${this.d.stateFile}.tmp`, this.d.stateFile);
    } catch (err) {
      this.d.logger.error({ err: err instanceof Error ? err.message : String(err) }, "could not save runner-state.json");
    }
  }

  private loadState(): State {
    try {
      if (!existsSync(this.d.stateFile)) return {};
      const raw = JSON.parse(readFileSync(this.d.stateFile, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return {};
      return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number")) as State;
    } catch {
      return {};
    }
  }
}

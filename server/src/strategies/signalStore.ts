import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.js";
import type { DcaFill } from "./dca.js";
import type { ExitReason, StrategyTimeframe } from "./types.js";

/**
 * One signal made by a strategy of the library, stored in data/strategy-signals.json.
 *  PENDING: the signal was made on the close of a candle; the position enters at the open of the next one.
 *  OPEN:    entered. CLOSED: ended (or CANCELLED if the entry never happened).
 */
export interface StrategySignal {
  /** `<strategyId>:<symbol>:<open time of the signal candle>` (grid and DCA signals have their own ids): never made twice. */
  id: string;
  strategyId: string;
  symbol: string;
  timeframe: StrategyTimeframe;
  direction: "BUY";
  /** The signal candle's close while PENDING, the entry price (the next candle's open) once OPEN. */
  entry: number;
  /** The first stop. It defines the risk (1R). */
  stopLoss: number;
  /** The stop in force now, if a trailing stop moved it. */
  trailStop?: number;
  /** The strategy's own targets (empty when it exits on a rule). */
  targets: number[];
  /** tp1 to tp3: the strategy's targets. A strategy with one target uses it for all three. Undefined when it has none. */
  tp1?: number;
  tp2?: number;
  tp3?: number;
  /** Close time of the signal candle (when the signal was made), epoch ms. */
  createdAt: number;
  /** Open time of the signal candle. */
  candleTime: number;
  /** Open time of the newest candle already checked against this signal. */
  lastCheckedCandle: number;
  /** Open time of the entry candle, once entered. */
  filledAt?: number;
  /** True only if the strategy PASSED its backtest for this symbol and timeframe when the signal was made. */
  validated: boolean;
  /** The opposite of validated: stored for backtest and logging, never posted and never traded in demo. */
  researchOnly: boolean;
  note?: string;
  status: "PENDING" | "OPEN" | "CLOSED";
  /** DcaAccumulator: the signal it follows. */
  parentId?: string;
  /** DcaAccumulator: its fills so far, and whether the remaining parts were cancelled. */
  dca?: { fills: DcaFill[]; cancelled: boolean };
  outcome?: { reason: ExitReason; exitPrice: number; closedAt: number; returnPercent: number; netR: number };
}

export interface StrategySignalQuery {
  strategyId?: string;
  symbol?: string;
  limit?: number;
  offset?: number;
}

export class StrategySignalStore {
  private signals: StrategySignal[] = [];

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  load(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("file does not contain an array");
      this.signals = parsed as StrategySignal[];
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      this.logger.error({ err, aside }, "strategy signals file unreadable, setting it aside and starting empty");
      renameSync(this.file, aside);
    }
  }

  add(signal: StrategySignal): void {
    this.signals.push(signal);
    this.save();
  }

  update(signal: StrategySignal): void {
    const at = this.signals.findIndex((s) => s.id === signal.id);
    if (at >= 0) this.signals[at] = signal;
    this.save();
  }

  get(id: string): StrategySignal | undefined {
    return this.signals.find((s) => s.id === id);
  }

  /** The PENDING or OPEN signal of a strategy on a symbol (a standard strategy has at most one). */
  activeFor(strategyId: string, symbol: string): StrategySignal | undefined {
    return this.signals.find((s) => s.status !== "CLOSED" && s.strategyId === strategyId && s.symbol === symbol);
  }

  /** Entered signals that are still running, optionally of one symbol. */
  open(symbol?: string): StrategySignal[] {
    return this.signals.filter((s) => s.status === "OPEN" && (!symbol || s.symbol === symbol));
  }

  /** PENDING and OPEN signals. */
  active(symbol?: string): StrategySignal[] {
    return this.signals.filter((s) => s.status !== "CLOSED" && (!symbol || s.symbol === symbol));
  }

  all(): StrategySignal[] {
    return this.signals;
  }

  /** Newest first. */
  query(q: StrategySignalQuery = {}): { signals: StrategySignal[]; total: number } {
    const matches = this.signals.filter((s) => (!q.strategyId || s.strategyId === q.strategyId) && (!q.symbol || s.symbol === q.symbol)).reverse();
    const offset = q.offset ?? 0;
    return { signals: matches.slice(offset, offset + (q.limit ?? 100)), total: matches.length };
  }

  private save(): void {
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.signals));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.logger.error({ err }, "could not save strategy signals");
    }
  }
}

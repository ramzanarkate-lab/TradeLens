import type { Candle } from "../types/index.js";

export type StrategyTimeframe = "15m" | "1h" | "4h";

export const TIMEFRAME_MS: Record<StrategyTimeframe, number> = { "15m": 15 * 60_000, "1h": 3_600_000, "4h": 4 * 3_600_000 };

/** Stop and targets of a position, from the price it actually entered at. */
export interface Levels {
  stopLoss: number;
  /** The strategy's own price targets, nearest first. Empty when the strategy exits on a rule instead of a price. */
  targets: number[];
}

/** An open position, as the exit rules see it. */
export interface OpenPosition {
  entry: number;
  /** The stop in force now (a trailing stop moves it up, never down). */
  stop: number;
  /** Index of the candle the position entered on (the candle after the signal candle). */
  entryIndex: number;
}

/** What a rule evaluated at a candle's close can do to an open position. */
export interface CloseCheck {
  /** Close the position at this candle's close, for this reason. */
  exit?: string;
  /** Raise the stop to this level (used by trailing stops). */
  stop?: number;
}

/**
 * What a strategy found on the close of a candle. Every strategy is long only, and a position enters at the OPEN of the
 * next candle: the stop and targets are worked out from that entry price once it is known.
 */
export interface Plan {
  levels(entry: number): Levels;
  /** The strategy's own time exit, in bars counted from the signal candle (1 = the entry candle). */
  maxBars?: number;
  /** A rule evaluated at the close of each candle j from the entry candle on, while the position is open. */
  onClose?(j: number, pos: OpenPosition): CloseCheck | null;
  note?: string;
}

export interface StrategyContext {
  symbol: string;
  log?: (message: string) => void;
}

/** A strategy bound to one series of closed candles (indicators are computed once). */
export interface StrategyInstance {
  /** Looks at the close of candle `i` (using candles up to `i` only). Returns a plan, or null. */
  signal(i: number): Plan | null;
  /** The plan for a signal that was made on candle `i`, without checking the entry conditions again (used to follow an open signal). */
  plan(i: number): Plan;
}

/**
 *  standard: one open position per symbol, entering at the next candle's open.
 *  grid:     GridTrading, up to 5 open positions at once (see grid.ts).
 *  dca:      DcaAccumulator, only a follow-up to another strategy's buy (see dca.ts).
 */
export type StrategyKind = "standard" | "grid" | "dca";

export interface Strategy {
  id: string;
  name: string;
  /** The library's number for this strategy. */
  number: number;
  timeframe: StrategyTimeframe;
  kind: StrategyKind;
  /** Candles needed before the indicators are ready. */
  warmup: number;
  create(candles: Candle[], ctx: StrategyContext): StrategyInstance;
}

/** How a strategy signal ended. CANCELLED means it never entered. */
export type ExitReason = "TP" | "SL" | "TIME" | "EXIT_SIGNAL" | "EXPIRED" | "EXIT_ALL" | "CANCELLED";

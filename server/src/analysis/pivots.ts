import type { Symbol } from "../config/symbols.js";
import type { Candle, PivotLevels } from "../types/index.js";

/** Price decimals (tick size) per symbol. */
export const PRICE_DECIMALS: Record<Symbol, number> = {
  BTCUSDT: 2,
  SOLUSDT: 3,
  ETHUSDT: 2,
};

export interface PivotsResult extends PivotLevels {
  symbol: Symbol;
  basis: "daily";
  /** UTC date (YYYY-MM-DD) of the daily candle the levels are based on. */
  date: string;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Classic pivot levels from one candle's high, low and close, rounded to `decimals`. */
export function classicPivots(high: number, low: number, close: number, decimals: number): PivotLevels {
  const P = (high + low + close) / 3;
  const range = high - low;
  const levels: PivotLevels = {
    P,
    R1: 2 * P - low,
    S1: 2 * P - high,
    R2: P + range,
    S2: P - range,
    R3: high + 2 * (P - low),
    S3: low - 2 * (high - P),
  };
  return Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, roundTo(v, decimals)])) as unknown as PivotLevels;
}

/**
 * Pivots from the previous *completed* daily candle. The current (still forming) candle is ignored:
 * only candles with closed=true are considered and the newest of those is used.
 * Returns null when the series has no completed candle.
 */
export function computePivots(symbol: Symbol, daily: Candle[]): PivotsResult | null {
  const base = daily.filter((c) => c.closed).reduce<Candle | undefined>((best, c) => (!best || c.time > best.time ? c : best), undefined);
  if (!base) return null;
  return {
    symbol,
    basis: "daily",
    date: new Date(base.time).toISOString().slice(0, 10),
    ...classicPivots(base.high, base.low, base.close, PRICE_DECIMALS[symbol]),
  };
}

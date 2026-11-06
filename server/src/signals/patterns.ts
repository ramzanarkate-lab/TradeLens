import type { Candle } from "../types/index.js";

/** One toggle per pattern family. Each one controls both the bullish pattern and its bearish mirror. */
export const PATTERN_KEYS = ["hammer", "engulfing", "piercing", "morningStar", "tweezer"] as const;
export type PatternKey = (typeof PATTERN_KEYS)[number];
export type PatternSwitches = Record<PatternKey, boolean>;
export const ALL_PATTERNS_ON: Readonly<PatternSwitches> = Object.freeze({ hammer: true, engulfing: true, piercing: true, morningStar: true, tweezer: true });

export type PatternDirection = "bullish" | "bearish";

export interface PatternHit {
  key: PatternKey;
  direction: PatternDirection;
  /** Plain-English name, e.g. "Bullish engulfing" or "Shooting star". */
  name: string;
  /** Lowest low (bullish) or highest high (bearish) of the candles that form the pattern. */
  extreme: number;
}

const NAMES: Record<PatternKey, { bullish: string; bearish: string }> = {
  hammer: { bullish: "Hammer", bearish: "Shooting star" },
  engulfing: { bullish: "Bullish engulfing", bearish: "Bearish engulfing" },
  piercing: { bullish: "Piercing line", bearish: "Dark cloud cover" },
  morningStar: { bullish: "Morning star", bearish: "Evening star" },
  tweezer: { bullish: "Tweezer bottom", bearish: "Tweezer top" },
};

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;
const isBull = (c: Candle) => c.close > c.open;
const isBear = (c: Candle) => c.close < c.open;
const bodyTop = (c: Candle) => Math.max(c.open, c.close);
const bodyBottom = (c: Candle) => Math.min(c.open, c.close);
const mid = (c: Candle) => (c.open + c.close) / 2;

/** Hammer (bullish): lower wick >= 2x body, upper wick < 0.3x body, close in the upper half. Shooting star is the mirror. */
export function isHammer(c: Candle, direction: PatternDirection): boolean {
  const b = body(c);
  if (b <= 0 || range(c) <= 0) return false;
  const lower = bodyBottom(c) - c.low;
  const upper = c.high - bodyTop(c);
  const half = (c.high + c.low) / 2;
  return direction === "bullish" ? lower >= 2 * b && upper < 0.3 * b && c.close >= half : upper >= 2 * b && lower < 0.3 * b && c.close <= half;
}

/** The body of `cur` fully covers the body of the opposite-colour `prev`. */
export function isEngulfing(prev: Candle, cur: Candle, direction: PatternDirection): boolean {
  if (direction === "bullish") return isBear(prev) && isBull(cur) && cur.open <= prev.close && cur.close >= prev.open && body(cur) > body(prev);
  return isBull(prev) && isBear(cur) && cur.open >= prev.close && cur.close <= prev.open && body(cur) > body(prev);
}

/** Piercing line: opens below the prior low and closes above the middle of the prior bearish body (but not above its open). Dark cloud cover is the mirror. */
export function isPiercing(prev: Candle, cur: Candle, direction: PatternDirection): boolean {
  if (direction === "bullish") return isBear(prev) && isBull(cur) && cur.open < prev.low && cur.close > mid(prev) && cur.close < prev.open;
  return isBull(prev) && isBear(cur) && cur.open > prev.high && cur.close < mid(prev) && cur.close > prev.open;
}

/** Morning star: large bearish candle, a small body, then a bullish candle closing above the middle of the first. Evening star is the mirror. */
export function isStar(c0: Candle, c1: Candle, c2: Candle, direction: PatternDirection): boolean {
  const large = body(c0) >= 0.6 * range(c0) && range(c0) > 0;
  const small = body(c1) <= 0.3 * body(c0);
  if (!large || !small) return false;
  return direction === "bullish" ? isBear(c0) && isBull(c2) && c2.close > mid(c0) : isBull(c0) && isBear(c2) && c2.close < mid(c0);
}

/** Tweezer bottom: two lows within 0.1 x ATR of each other and the second candle bullish. Tweezer top is the mirror (highs, bearish). */
export function isTweezer(prev: Candle, cur: Candle, atr: number, direction: PatternDirection): boolean {
  if (!(atr > 0)) return false;
  return direction === "bullish" ? Math.abs(prev.low - cur.low) <= 0.1 * atr && isBull(cur) : Math.abs(prev.high - cur.high) <= 0.1 * atr && isBear(cur);
}

/**
 * Every enabled pattern that ENDS on the candle at index `i`. Pure: only candles up to `i` are used.
 * `atr` is the ATR(14) of the same series at `i`.
 */
export function detectPatterns(candles: Candle[], i: number, atr: number, enabled: Readonly<PatternSwitches> = ALL_PATTERNS_ON): PatternHit[] {
  const cur = candles[i];
  if (!cur) return [];
  const prev = candles[i - 1];
  const prev2 = candles[i - 2];
  const hits: PatternHit[] = [];
  for (const direction of ["bullish", "bearish"] as const) {
    const lowOrHigh = (...cs: Candle[]) => (direction === "bullish" ? Math.min(...cs.map((c) => c.low)) : Math.max(...cs.map((c) => c.high)));
    const hit = (key: PatternKey, ...cs: Candle[]) => hits.push({ key, direction, name: NAMES[key][direction], extreme: lowOrHigh(...cs) });
    if (enabled.hammer && isHammer(cur, direction)) hit("hammer", cur);
    if (prev && enabled.engulfing && isEngulfing(prev, cur, direction)) hit("engulfing", prev, cur);
    if (prev && enabled.piercing && isPiercing(prev, cur, direction)) hit("piercing", prev, cur);
    if (prev && prev2 && enabled.morningStar && isStar(prev2, prev, cur, direction)) hit("morningStar", prev2, prev, cur);
    if (prev && enabled.tweezer && isTweezer(prev, cur, atr, direction)) hit("tweezer", prev, cur);
  }
  return hits;
}

export interface KeyLevel {
  name: string;
  price: number;
}

/** The key level (if any) within `toleranceAtr` x ATR of a pattern's extreme. The nearest one wins. */
export function nearestKeyLevel(extreme: number, levels: KeyLevel[], atr: number, toleranceAtr: number): KeyLevel | null {
  let best: KeyLevel | null = null;
  let bestDistance = Infinity;
  for (const level of levels) {
    if (!Number.isFinite(level.price)) continue;
    const d = Math.abs(extreme - level.price);
    if (d <= toleranceAtr * atr && d < bestDistance) {
      best = level;
      bestDistance = d;
    }
  }
  return best;
}

/** Lowest low (bullish) or highest high (bearish) of the 20 candles before index `from` (the pattern's first candle). */
export function swingExtreme(candles: Candle[], from: number, direction: PatternDirection, length = 20): number {
  const slice = candles.slice(Math.max(0, from - length), from);
  if (slice.length === 0) return NaN;
  return direction === "bullish" ? Math.min(...slice.map((c) => c.low)) : Math.max(...slice.map((c) => c.high));
}

/** How many candles a pattern spans, so the swing level can be measured from before it. */
export const PATTERN_SPAN: Record<PatternKey, number> = { hammer: 1, engulfing: 2, piercing: 2, morningStar: 3, tweezer: 2 };

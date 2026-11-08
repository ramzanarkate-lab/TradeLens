import type { Candle, PivotLevels, SignalSide } from "../types/index.js";
import { detectPatterns, nearestKeyLevel, PATTERN_SPAN, swingExtreme, type KeyLevel, type PatternSwitches } from "./patterns.js";

export interface ReversalConfig {
  enabled: boolean;
  /** Volume ratio (candle volume / 20-candle average) that confirms a pattern: +5 points. */
  minVolumeRatio: number;
  /** A pattern counts only within this many ATR of a key level. */
  levelToleranceAtr: number;
  patterns: Readonly<PatternSwitches>;
}

/** One timeframe's closed candle and the numbers measured on it. */
export interface ReversalInput {
  label: string;
  candles: Candle[];
  /** Index of the candle that just closed. */
  i: number;
  atr: number;
  ema50: number;
  ema200: number;
  volRatio: number;
}

export interface ReversalResult {
  /** 0, 10 or 15 (never more than 15). */
  points: number;
  reasons: string[];
  /** Set when a reversal pattern against the signal direction sits at a key level. */
  veto: string | null;
}

export const MAX_REVERSAL_POINTS = 15;
const f = (n: number) => n.toFixed(1);

/**
 * Reversal candles add points to a signal that already exists, and never create one.
 * A pattern counts only at a key level: pivot S1-S3 (BUY) or R1-R3 (SELL), EMA50, EMA200, or the 20-candle swing low/high.
 * In the signal's direction at a key level: +10, and +5 more with volume at or above the minimum. Against it: veto.
 */
export function assessReversal(side: SignalSide, inputs: ReversalInput[], pivots: PivotLevels, cfg: ReversalConfig): ReversalResult {
  const none: ReversalResult = { points: 0, reasons: [], veto: null };
  if (!cfg.enabled) return none;
  const wanted = side === "BUY" ? "bullish" : "bearish";
  let best: { points: number; reason: string } | null = null;

  for (const tf of inputs) {
    if (!(tf.atr > 0) || Number.isNaN(tf.atr)) continue;
    for (const hit of detectPatterns(tf.candles, tf.i, tf.atr, cfg.patterns)) {
      const levels: KeyLevel[] =
        hit.direction === "bullish"
          ? [{ name: "S1", price: pivots.S1 }, { name: "S2", price: pivots.S2 }, { name: "S3", price: pivots.S3 }]
          : [{ name: "R1", price: pivots.R1 }, { name: "R2", price: pivots.R2 }, { name: "R3", price: pivots.R3 }];
      levels.push({ name: "EMA50", price: tf.ema50 }, { name: "EMA200", price: tf.ema200 });
      levels.push({ name: hit.direction === "bullish" ? "the 20-candle swing low" : "the 20-candle swing high", price: swingExtreme(tf.candles, tf.i - PATTERN_SPAN[hit.key] + 1, hit.direction) });
      const level = nearestKeyLevel(hit.extreme, levels, tf.atr, cfg.levelToleranceAtr);
      if (!level) continue; // away from a level a pattern scores nothing and blocks nothing

      const where = tf.label === "4H" ? " (4H)" : "";
      if (hit.direction !== wanted) {
        return { points: 0, reasons: [], veto: `veto: ${hit.name}${where} at ${level.name} against this ${side}` };
      }
      const confirmed = tf.volRatio >= cfg.minVolumeRatio;
      const points = confirmed ? MAX_REVERSAL_POINTS : 10;
      const reason = `${hit.name}${where} at ${level.name}${confirmed ? ` with volume ${f(tf.volRatio)}× average` : ""}`;
      if (!best || points > best.points) best = { points, reason };
    }
  }
  return best ? { points: best.points, reasons: [best.reason], veto: null } : none;
}

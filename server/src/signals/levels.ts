import type { PivotLevels, SignalSide } from "../types/index.js";

export interface LevelInput {
  side: SignalSide;
  /** Close of the trigger candle. */
  entry: number;
  /** ATR(14) on the 1H series. */
  atr: number;
  /** Highs and lows of the last 5 closed 1H candles (the trigger candle included). */
  recentLows: number[];
  recentHighs: number[];
  pivots: PivotLevels;
  /** Price decimals (tick size) of the symbol. */
  decimals: number;
  minRiskPercent: number;
  maxRiskPercent: number;
  /** Stop buffer in ATR(14) units, beyond the swing / pivot. Default 0.5. */
  stopBufferAtr?: number;
  /** Scales the three targets: 1 = 1R, 2R, 3R (default). 0.5 = 0.5R, 1R, 1.5R. */
  targetScale?: number;
}

export const DEFAULT_STOP_BUFFER_ATR = 0.5;

export interface Levels {
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskPercent: number;
  rrTp1: number;
  rrTp2: number;
  rrTp3: number;
}

export type LevelsResult = { ok: true; levels: Levels } | { ok: false; reason: string };

const roundTo = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/**
 * Entry, stop-loss and three targets.
 *  BUY  stop = min(lowest low of the last 5 candles, S1) - stopBufferAtr x ATR     SELL stop = max(highest high of the last 5, R1) + stopBufferAtr x ATR
 *  (stopBufferAtr defaults to 0.5)
 *  Risk R = |entry - stop|; rejected if R is below minRiskPercent or above maxRiskPercent of the entry.
 *  Targets are 1R, 2R, 3R. If a pivot (BUY: R1-R3, SELL: S1-S3) lies between the entry and a target, that target becomes the
 *  nearest such pivot, but only when its reward-to-risk is still at least 1.0 and it lies beyond the previous target.
 * All prices are rounded to the tick size.
 */
export function computeLevels(input: LevelInput): LevelsResult {
  const { side, entry, atr, pivots, decimals } = input;
  const dir = side === "BUY" ? 1 : -1;
  const r = (v: number) => roundTo(v, decimals);
  const buffer = (input.stopBufferAtr ?? DEFAULT_STOP_BUFFER_ATR) * atr;
  const scale = input.targetScale ?? 1;

  const sl = r(
    side === "BUY"
      ? Math.min(...input.recentLows, pivots.S1) - buffer
      : Math.max(...input.recentHighs, pivots.R1) + buffer,
  );
  const risk = Math.abs(entry - sl);
  if (!(risk > 0) || (side === "BUY" ? sl >= entry : sl <= entry)) return { ok: false, reason: "stop is on the wrong side of the entry" };
  const riskPercent = (risk / entry) * 100;
  if (riskPercent < input.minRiskPercent) return { ok: false, reason: `risk ${riskPercent.toFixed(2)}% is below ${input.minRiskPercent}%` };
  if (riskPercent > input.maxRiskPercent) return { ok: false, reason: `risk ${riskPercent.toFixed(2)}% is above ${input.maxRiskPercent}%` };

  const obstacles = (side === "BUY" ? [pivots.R1, pivots.R2, pivots.R3] : [pivots.S1, pivots.S2, pivots.S3])
    .filter((p) => (side === "BUY" ? p > entry : p < entry))
    .sort((a, b) => dir * (a - b)); // nearest to the entry first

  const targets: number[] = [];
  for (let k = 1; k <= 3; k++) {
    let tp = r(entry + dir * k * scale * risk);
    const previous = targets[k - 2];
    // pivots strictly between the entry and this target, with reward-to-risk >= 1.0, beyond the previous target
    const hit = obstacles.find(
      (p) => dir * (p - entry) > 0 && dir * (tp - p) > 0 && Math.abs(p - entry) / risk >= 1 && (previous === undefined || dir * (p - previous) > 0),
    );
    if (hit !== undefined) tp = r(hit);
    targets.push(tp);
  }
  const rr = (tp: number) => Math.round((Math.abs(tp - entry) / risk) * 100) / 100;
  return {
    ok: true,
    levels: {
      entry: r(entry),
      sl,
      tp1: targets[0]!,
      tp2: targets[1]!,
      tp3: targets[2]!,
      riskPercent: Math.round(riskPercent * 100) / 100,
      rrTp1: rr(targets[0]!),
      rrTp2: rr(targets[1]!),
      rrTp3: rr(targets[2]!),
    },
  };
}

/** Price move from the entry in percent, positive when it moved in the trade's favour (a SELL profits when the price falls). */
export function movePercent(side: SignalSide, entry: number, price: number): number {
  return ((side === "BUY" ? price - entry : entry - price) / entry) * 100;
}

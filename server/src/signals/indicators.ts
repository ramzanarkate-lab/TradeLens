import type { Candle } from "../types/index.js";

/** Close prices of the closed candles only, in order. Forming candles never feed an indicator. */
export function closedCloses(candles: Candle[]): number[] {
  return candles.filter((c) => c.closed).map((c) => c.close);
}

/**
 * Exponential moving average. Output has the same length as `values`; the first `period - 1`
 * entries are NaN and the EMA is seeded with the simple average of the first `period` values.
 */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index with Wilder smoothing. Output has the same length as `values`; the first
 * `period` entries are NaN. A window with no losses gives 100 (or 50 when it has no movement at all).
 */
export function rsi(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period < 1 || values.length <= period) return out;

  const toRsi = (avgGain: number, avgLoss: number) => {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  };

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

const nanArray = (n: number) => new Array<number>(n).fill(Number.NaN);

/** Simple moving average. The first `period - 1` entries are NaN. */
export function sma(values: number[], period: number): number[] {
  const out = nanArray(values.length);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export interface MacdResult {
  line: number[];
  signal: number[];
  histogram: number[];
}

/** MACD(fast, slow, signalPeriod): line = EMA(fast) - EMA(slow); signal = EMA of the line; histogram = line - signal. */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) => emaFast[i]! - emaSlow[i]!); // NaN until both exist
  const firstValid = line.findIndex((v) => !Number.isNaN(v));
  const signal = nanArray(values.length);
  if (firstValid >= 0) {
    const sig = ema(line.slice(firstValid), signalPeriod);
    sig.forEach((v, i) => (signal[firstValid + i] = v));
  }
  return { line, signal, histogram: values.map((_, i) => line[i]! - signal[i]!) };
}

interface Ohlc {
  high: number;
  low: number;
  close: number;
}

/** True range for each candle (index 0 has no previous close, so it is NaN). */
function trueRange(c: Ohlc[]): number[] {
  return c.map((x, i) => (i === 0 ? Number.NaN : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1]!.close), Math.abs(x.low - c[i - 1]!.close))));
}

/** Average True Range with Wilder smoothing. The first value is at index `period`. */
export function atr(candles: Ohlc[], period = 14): number[] {
  const out = nanArray(candles.length);
  if (candles.length <= period) return out;
  const tr = trueRange(candles);
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i]!;
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

/** ADX(period) with +DI and -DI, Wilder smoothing. +DI/-DI start at index `period`, ADX at index `2 * period - 1`. */
export function adx(candles: Ohlc[], period = 14): AdxResult {
  const n = candles.length;
  const res: AdxResult = { adx: nanArray(n), plusDi: nanArray(n), minusDi: nanArray(n) };
  if (n <= period * 2 - 1) return res;
  const tr = trueRange(candles);
  const plusDm = nanArray(n);
  const minusDm = nanArray(n);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) {
    smTr += tr[i]!;
    smPlus += plusDm[i]!;
    smMinus += minusDm[i]!;
  }
  const dx = nanArray(n);
  const setDi = (i: number) => {
    const p = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const m = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    res.plusDi[i] = p;
    res.minusDi[i] = m;
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  };
  setDi(period);
  for (let i = period + 1; i < n; i++) {
    smTr = smTr - smTr / period + tr[i]!;
    smPlus = smPlus - smPlus / period + plusDm[i]!;
    smMinus = smMinus - smMinus / period + minusDm[i]!;
    setDi(i);
  }
  let prev = 0;
  for (let i = period; i <= 2 * period - 1; i++) prev += dx[i]!;
  prev /= period;
  res.adx[2 * period - 1] = prev;
  for (let i = 2 * period; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]!) / period;
    res.adx[i] = prev;
  }
  return res;
}

export interface BollingerResult {
  middle: number[];
  upper: number[];
  lower: number[];
}

/** Bollinger Bands(period, k): SMA plus and minus k population standard deviations. */
export function bollinger(values: number[], period = 20, k = 2): BollingerResult {
  const middle = sma(values, period);
  const upper = nanArray(values.length);
  const lower = nanArray(values.length);
  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i]!;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j]! - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mean + k * sd;
    lower[i] = mean - k * sd;
  }
  return { middle, upper, lower };
}

/** Volume SMA(period). */
export function volumeSma(volumes: number[], period = 20): number[] {
  return sma(volumes, period);
}

/** Volume divided by its SMA(period) at the same candle (the SMA includes that candle). */
export function volumeRatio(volumes: number[], period = 20): number[] {
  const avg = volumeSma(volumes, period);
  return volumes.map((v, i) => (Number.isNaN(avg[i]!) || avg[i] === 0 ? Number.NaN : v / avg[i]!));
}

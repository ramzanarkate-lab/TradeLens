import type { Timeframe } from "../config/symbols.js";
import type { Candle } from "../types/index.js";

const MINUTE = 60_000;

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15m": 15 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 4 * 60 * MINUTE,
  "1d": 24 * 60 * MINUTE,
};

/**
 * Builds candles of `timeframe` from 1-minute candles. Buckets are aligned to UTC epoch (like Binance).
 * A bucket is `closed` only when its first and final minutes are present and the final one is closed. Input need not be sorted;
 * duplicate minutes keep the last one given. Output is ascending by time.
 */
export function aggregateCandles(oneMinute: Candle[], timeframe: Timeframe): Candle[] {
  const size = TIMEFRAME_MS[timeframe];
  const minutes = new Map<number, Candle>();
  for (const c of oneMinute) minutes.set(c.time, c);

  const buckets = new Map<number, Candle[]>();
  for (const c of [...minutes.values()].sort((a, b) => a.time - b.time)) {
    const start = Math.floor(c.time / size) * size;
    const list = buckets.get(start);
    if (list) list.push(c);
    else buckets.set(start, [c]);
  }

  return [...buckets.entries()].map(([start, list]) => {
    const last = list[list.length - 1]!;
    return {
      time: start,
      open: list[0]!.open,
      high: Math.max(...list.map((c) => c.high)),
      low: Math.min(...list.map((c) => c.low)),
      close: last.close,
      volume: list.reduce((sum, c) => sum + c.volume, 0),
      closed: last.closed && list[0]!.time === start && last.time + MINUTE >= start + size,
    };
  });
}

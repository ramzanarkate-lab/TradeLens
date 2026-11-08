import { createHash } from "node:crypto";
import type { Trade } from "../../src/backtest/backtest.js";
import { DAY_MS, H4_MS, HOUR_MS, type MtfSeries } from "../../src/signals/mtf.js";
import type { Candle } from "../../src/types/index.js";

/**
 * A fixed, seeded candle set: 300 days of hourly candles that swing up and down (so the 1D trend flips between BUY and SELL),
 * regrouped into 4H and 1D. Used to prove that the default timeframe gives the same results as the code before --timeframe existed.
 */
export function baselineSeries(): MtfSeries {
  let seed = 20260101;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const h1: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < 300 * 24; i++) {
    const open = price;
    price = open * (1 + Math.sin(i / (24 * 38)) * 0.0007 + (rnd() - 0.5) * 0.012);
    h1.push({ time: i * HOUR_MS, open, high: Math.max(open, price) * 1.002, low: Math.min(open, price) * 0.998, close: price, volume: 100 + rnd() * 100, closed: true });
  }
  const regroup = (size: number) => {
    const per = size / HOUR_MS;
    const out: Candle[] = [];
    for (let k = 0; k + per <= h1.length; k += per) {
      const g = h1.slice(k, k + per);
      out.push({ time: g[0]!.time, open: g[0]!.open, high: Math.max(...g.map((c) => c.high)), low: Math.min(...g.map((c) => c.low)), close: g[per - 1]!.close, volume: g.reduce((s, c) => s + c.volume, 0), closed: true });
    }
    return out;
  };
  return { h1, h4: regroup(H4_MS), d1: regroup(DAY_MS) };
}

/** A fingerprint of every field of every trade (signals, reasons, exits, R), in order. */
export function fingerprint(trades: Trade[]): { count: number; sha256: string } {
  const text = JSON.stringify(trades.map((t) => ({ signal: t.signal, exitStatus: t.exitStatus, exitPrice: t.exitPrice, grossR: t.grossR, netR: t.netR })));
  return { count: trades.length, sha256: createHash("sha256").update(text).digest("hex") };
}

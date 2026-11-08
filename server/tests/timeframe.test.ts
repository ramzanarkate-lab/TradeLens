import { describe, expect, it } from "vitest";
import { parseTimeframe, replay } from "../src/backtest/backtest.js";
import { H4_MS, HOUR_MS, TRIGGER_MS, type MtfSeries } from "../src/signals/mtf.js";
import type { Candle } from "../src/types/index.js";
import { baselineSeries, fingerprint } from "./fixtures/baselineSeries.js";

const config = { minScore: 50, minRiskPercent: 0, maxRiskPercent: 100, mode: "paper" as const };
const run = (series: MtfSeries, timeframe?: "15m" | "1h" | "4h", cfg = config, startDays = 40) =>
  replay({ symbol: "BTCUSDT", series, startTime: series.h1[0]!.time + startDays * 24 * HOUR_MS, config: cfg, timeStopHours: 48, ...(timeframe ? { timeframe } : {}) });

/**
 * The expected values were measured with the code as it was BEFORE --timeframe existed (same fixed candles, same settings),
 * then written down here. If the default 1h behaviour ever changes, this test fails.
 */
const BASELINE = { count: 44, sha256: "94b32e939ad9f5de096e0bd43a72cc21733a2ac7cf9f2719d3c217704be3ede8", sells: 41, buys: 3, openAtEnd: 1 };

describe("default timeframe (1h) is identical to the code before --timeframe", () => {
  const series = baselineSeries();

  it("the fixed candle set gives the measured baseline: same trades, same stops, targets, reasons and R", () => {
    const r = run(series);
    expect(fingerprint(r.trades)).toEqual({ count: BASELINE.count, sha256: BASELINE.sha256 });
    expect(r.trades.filter((t) => t.signal.side === "SELL")).toHaveLength(BASELINE.sells);
    expect(r.trades.filter((t) => t.signal.side === "BUY")).toHaveLength(BASELINE.buys);
    expect(r.openAtEnd).toBe(BASELINE.openAtEnd);
  });

  it('passing "1h" explicitly is the same as passing nothing', () => {
    expect(fingerprint(run(series, "1h").trades)).toEqual(fingerprint(run(series).trades));
  });

  it("1h signals keep the 1H labels and timeframe", () => {
    const s = run(series).trades[0]!.signal;
    expect(s.timeframe).toBe("1h");
    expect(s.reasons!.some((x) => x.startsWith("1H "))).toBe(true);
    expect(s.createdAt % HOUR_MS).toBe(0);
  });
});

describe("--timeframe value", () => {
  it("defaults to 1h and accepts 15m, 1h and 4h", () => {
    expect(parseTimeframe(undefined)).toBe("1h");
    for (const ok of ["15m", "1h", "4h"] as const) expect(parseTimeframe(ok)).toBe(ok);
  });

  it("rejects anything else", () => {
    for (const bad of ["1d", "5m", "30m", "1H", "", "4", "hour"]) expect(() => parseTimeframe(bad), bad).toThrow(/--timeframe must be one of 15m, 1h, 4h/);
  });
});

describe("other trigger timeframes", () => {
  const base = baselineSeries();
  const loose = { ...config, minScore: 0 };

  it("4h: the 4H candles are the trigger; signals are 4h, created when a 4H candle closes, labelled 4H", () => {
    const series: MtfSeries = { h1: base.h4, h4: base.h4, d1: base.d1 };
    const r = run(series, "4h", loose, 60);
    expect(r.trades.length + r.openAtEnd).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.signal.timeframe).toBe("4h");
      expect(t.signal.createdAt % H4_MS).toBe(0);
      expect(t.signal.reasons!.some((x) => x.startsWith("1H "))).toBe(false); // nothing is labelled with the old timeframe
    }
    const all = r.trades.flatMap((t) => t.signal.reasons!);
    expect(all.some((x) => /^4H (RSI|MACD histogram|close)/.test(x))).toBe(true); // trigger reasons carry the 4H label
  });

  it("15m: 15-minute candles are the trigger; signals are 15m and created on 15-minute closes", () => {
    const m15: Candle[] = [];
    for (const c of base.h1) {
      for (let k = 0; k < 4; k++) {
        const open = c.open + ((c.close - c.open) * k) / 4;
        const close = c.open + ((c.close - c.open) * (k + 1)) / 4;
        m15.push({ time: c.time + k * 900_000, open, close, high: Math.max(open, close) * 1.0005, low: Math.min(open, close) * 0.9995, volume: c.volume / 4, closed: true });
      }
    }
    const r = run({ h1: m15, h4: base.h4, d1: base.d1 }, "15m", loose, 60);
    expect(r.trades.length + r.openAtEnd).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.signal.timeframe).toBe("15m");
      expect(t.signal.createdAt % TRIGGER_MS["15m"]).toBe(0);
    }
  });

  it("a different timeframe changes the results (so the default test is not trivially true)", () => {
    const series: MtfSeries = { h1: base.h4, h4: base.h4, d1: base.d1 };
    expect(fingerprint(run(series, "4h", config, 60).trades).sha256).not.toBe(BASELINE.sha256);
  });
});

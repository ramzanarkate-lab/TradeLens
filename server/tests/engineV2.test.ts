import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, evaluateAt, meetsMinScore, prepareContext, scoreSide, type ScoreFacts } from "../src/signals/engine.v2.js";
import { advance } from "../src/signals/lifecycle.js";
import { computeLevels } from "../src/signals/levels.js";
import { alignIndices, DAY_MS, H4_MS, HOUR_MS } from "../src/signals/mtf.js";
import type { PivotLevels, Signal } from "../src/types/index.js";
import type { Candle } from "../src/types/index.js";

const noPivots: PivotLevels = { P: 100, R1: 1000, R2: 1100, R3: 1200, S1: 99, S2: 90, S3: 80 };

describe("scoring", () => {
  const base: ScoreFacts = {
    price: 100, ema20h4: 100, ema50h4: 99, adx: 25, plusDi: 30, minusDi: 10, atrH4: 2, nearLevel: 99,
    rsi: 45, rsiPrev: 43, histPrev: -0.1, hist: 0.1, close: 101, ema20h1: 100, volRatio: 1.5,
  };

  it("a perfect BUY setup scores 100 with every reason listed", () => {
    const s = scoreSide("BUY", base);
    expect(s.total).toBe(100);
    expect(s.reasons).toHaveLength(7);
  });

  it("a perfect SELL setup scores 100", () => {
    const sell: ScoreFacts = {
      ...base, ema20h4: 99, ema50h4: 100, plusDi: 10, minusDi: 30, nearLevel: 101, rsi: 55, rsiPrev: 57,
      histPrev: 0.1, hist: -0.1, close: 99, ema20h1: 100,
    };
    expect(scoreSide("SELL", sell).total).toBe(100);
  });

  it("the score is exactly 70 here, which meets the threshold of 70; 69 does not", () => {
    // 4H setup 40 + MACD cross 20 + close above EMA20 10 = 70 (no RSI points, no volume points)
    const s = scoreSide("BUY", { ...base, rsi: 60, volRatio: 1.0 });
    expect(s.total).toBe(70);
    expect(meetsMinScore(s.total, 70)).toBe(true);
    expect(meetsMinScore(69, 70)).toBe(false);
    expect(meetsMinScore(s.total, 71)).toBe(false);
  });

  it("ADX below 20 or the wrong DI scores nothing for that rule", () => {
    expect(scoreSide("BUY", { ...base, adx: 19.9 }).total).toBe(85);
    expect(scoreSide("BUY", { ...base, plusDi: 5, minusDi: 20 }).total).toBe(85);
  });
});

describe("levels", () => {
  const common = { atr: 1, decimals: 2, minRiskPercent: 0.4, maxRiskPercent: 4 };

  it("BUY: stop below the lowest of the last 5 lows and S1, minus half an ATR; targets at 1R, 2R, 3R", () => {
    const r = computeLevels({ ...common, side: "BUY", entry: 100, recentLows: [99.5, 98.5, 98.2, 99, 99.2], recentHighs: [], pivots: noPivots });
    expect(r).toEqual({
      ok: true,
      levels: { entry: 100, sl: 97.7, tp1: 102.3, tp2: 104.6, tp3: 106.9, riskPercent: 2.3, rrTp1: 1, rrTp2: 2, rrTp3: 3 },
    });
  });

  it("SELL: stop above the highest of the last 5 highs and R1, plus half an ATR; targets below", () => {
    const r = computeLevels({ ...common, side: "SELL", entry: 100, recentHighs: [100.5, 101.8, 101, 100.2, 100.9], recentLows: [], pivots: { ...noPivots, R1: 101, S1: 1, S2: 1, S3: 1 } });
    expect(r).toEqual({
      ok: true,
      levels: { entry: 100, sl: 102.3, tp1: 97.7, tp2: 95.4, tp3: 93.1, riskPercent: 2.3, rrTp1: 1, rrTp2: 2, rrTp3: 3 },
    });
  });

  it("a pivot replaces a target only when reward-to-risk stays at or above 1.0 (and it is past the previous target)", () => {
    const pivots = { ...noPivots, R1: 101.5, R2: 103.5, R3: 110 };
    const r = computeLevels({ ...common, side: "BUY", entry: 100, recentLows: [98.2], recentHighs: [], pivots });
    if (!r.ok) throw new Error("expected levels");
    expect(r.levels.tp1).toBe(102.3); // R1 at 101.5 would be only 0.65R, so TP1 stays
    expect(r.levels.tp2).toBe(103.5); // R2: 1.52R, replaces 2R
    expect(r.levels.rrTp2).toBe(1.52);
    expect(r.levels.tp3).toBe(106.9); // nothing usable between TP2 and 3R
  });

  it("rejects risk below 0.4% or above 4% of the entry", () => {
    const tight = computeLevels({ ...common, atr: 0.05, side: "BUY", entry: 100, recentLows: [99.9], recentHighs: [], pivots: { ...noPivots, S1: 99.95 } });
    expect(tight.ok).toBe(false);
    const wide = computeLevels({ ...common, side: "BUY", entry: 100, recentLows: [94], recentHighs: [], pivots: noPivots });
    expect(wide.ok).toBe(false);
  });

  it("rounds to the tick size", () => {
    const r = computeLevels({ ...common, decimals: 3, side: "BUY", entry: 150.1234, recentLows: [148.5551], recentHighs: [], pivots: { ...noPivots, S1: 149 } });
    if (!r.ok) throw new Error("expected levels");
    for (const v of [r.levels.entry, r.levels.sl, r.levels.tp1, r.levels.tp2, r.levels.tp3]) expect(Math.round(v * 1000) / 1000).toBe(v);
  });
});

describe("lifecycle", () => {
  const buy: Signal = {
    id: "s", symbol: "BTCUSDT", side: "BUY", timeframe: "1h", price: 100,
    levels: { S1: 99, R2: 1100, pivots: noPivots }, indicators: { emaFast: 1, emaSlow: 1, rsi: 50 },
    trigger: "multi_indicator", reason: "", createdAt: 0, mode: "paper", entry: 100, sl: 97.7, tp1: 102.3, tp2: 104.6, tp3: 106.9,
    rrTp1: 1, rrTp2: 2, rrTp3: 3, status: "OPEN", statusHistory: [{ status: "OPEN", at: 0, price: 100, resultR: null }], closedAt: null, resultR: null,
  };
  const bar = (high: number, low: number, close: number, at: number) => ({ high, low, close, at });

  it("moves the stop to breakeven after TP1, then exits at the entry", () => {
    const a = advance(buy, bar(103, 100.5, 102, HOUR_MS), 48);
    expect(a.signal.status).toBe("TP1_HIT");
    expect(a.changes.map((c) => [c.status, c.resultR])).toEqual([["TP1_HIT", 1]]);
    const b = advance(a.signal, bar(101, 99.9, 100, 2 * HOUR_MS), 48);
    expect(b.signal.status).toBe("BREAKEVEN_EXIT");
    expect(b.signal.resultR).toBe(0);
    expect(b.signal.closedAt).toBe(2 * HOUR_MS);
  });

  it("a candle that touches both the stop and TP1 records SL_HIT", () => {
    const r = advance(buy, bar(103, 97, 100, HOUR_MS), 48);
    expect(r.signal.status).toBe("SL_HIT");
    expect(r.signal.resultR).toBe(-1);
    expect(r.changes).toHaveLength(1);
  });

  it("runs through TP1, TP2 and TP3 in one candle and closes at +3R", () => {
    const r = advance(buy, bar(107, 100.5, 106, HOUR_MS), 48);
    expect(r.changes.map((c) => c.status)).toEqual(["TP1_HIT", "TP2_HIT", "TP3_HIT"]);
    expect(r.signal.resultR).toBe(3);
    expect(r.signal.closedAt).toBe(HOUR_MS);
  });

  it("closes with TIME_EXIT after 48 hours without a resolution, at that candle's close", () => {
    const early = advance(buy, bar(101, 99.5, 100.5, 47 * HOUR_MS), 48);
    expect(early.signal.status).toBe("OPEN");
    const r = advance(buy, bar(101, 99.5, 101, 48 * HOUR_MS), 48);
    expect(r.signal.status).toBe("TIME_EXIT");
    expect(r.signal.resultR).toBe(0.43); // (101 - 100) / 2.3
  });

  it("works for SELL too (stop above, targets below)", () => {
    const sell: Signal = { ...buy, side: "SELL", sl: 102.3, tp1: 97.7, tp2: 95.4, tp3: 93.1 };
    const hit = advance(sell, bar(99.5, 97.5, 98, HOUR_MS), 48);
    expect(hit.signal.status).toBe("TP1_HIT");
    const stopped = advance(sell, bar(103, 99, 100, HOUR_MS), 48);
    expect(stopped.signal.status).toBe("SL_HIT");
  });

  it("does nothing to a closed signal", () => {
    const closed = advance(buy, bar(103, 97, 100, HOUR_MS), 48).signal;
    expect(advance(closed, bar(200, 1, 100, 2 * HOUR_MS), 48).changes).toEqual([]);
  });
});

describe("multi-timeframe alignment (no lookahead)", () => {
  const mk = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: true });
  it("uses the last higher candle that had closed when the lower candle closed", () => {
    const h1 = [0, 1, 2, 3, 4, 5].map((h) => mk(h * HOUR_MS));
    const h4 = [mk(0), mk(H4_MS)];
    // The 1H candle starting at hour 3 closes at hour 4: the first 4H candle (0-4h) has just closed.
    expect(alignIndices(h1, HOUR_MS, h4, H4_MS)).toEqual([-1, -1, -1, 0, 0, 0]);
    const d1 = [mk(0)];
    expect(alignIndices(h1, HOUR_MS, d1, DAY_MS)).toEqual([-1, -1, -1, -1, -1, -1]);
  });
});

describe("trend filter on a full synthetic series", () => {
  // 280 days of hourly candles that drift up with noise, regrouped into 4H and 1D
  function series(drift: number) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const h1: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 280 * 24; i++) {
      const open = price;
      price = open * (1 + drift + (rnd() - 0.5) * 0.01);
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
  const config = { ...DEFAULT_ENGINE_CONFIG, minScore: 0, minRiskPercent: 0, maxRiskPercent: 100 };

  it("never gives a BUY when 1D price is below EMA200, and never a SELL when above", () => {
    const ctx = prepareContext("BTCUSDT", series(0.0004));
    const down = { ...ctx, ema200d: ctx.ema200d.map(() => 1e12) }; // every 1D close is below EMA200
    const up = { ...ctx, ema200d: ctx.ema200d.map(() => 1e-12) }; // every 1D close is above EMA200
    let sells = 0;
    let buys = 0;
    for (let i = 0; i < ctx.series.h1.length; i++) {
      const a = evaluateAt(down, i, { config, hasOpen: () => false });
      if (a.signal) {
        expect(a.signal.side).toBe("SELL");
        sells++;
      }
      const b = evaluateAt(up, i, { config, hasOpen: () => false });
      if (b.signal) {
        expect(b.signal.side).toBe("BUY");
        buys++;
      }
    }
    expect(sells).toBeGreaterThan(0);
    expect(buys).toBeGreaterThan(0);
  });

  it("blocks the signal when a same-direction signal is already open", () => {
    const ctx = prepareContext("BTCUSDT", series(0.0004));
    const up = { ...ctx, ema200d: ctx.ema200d.map(() => 1e-12) };
    const first = Array.from({ length: ctx.series.h1.length }, (_, i) => evaluateAt(up, i, { config, hasOpen: () => false })).findIndex((o) => o.signal);
    expect(first).toBeGreaterThan(0);
    const blocked = evaluateAt(up, first, { config, hasOpen: () => true });
    expect(blocked.signal).toBeNull();
  });

  it("a produced signal has every level and the reasons that passed", () => {
    const ctx = prepareContext("BTCUSDT", series(0.0004));
    const up = { ...ctx, ema200d: ctx.ema200d.map(() => 1e-12) };
    const out = Array.from({ length: ctx.series.h1.length }, (_, i) => evaluateAt(up, i, { config, hasOpen: () => false })).find((o) => o.signal);
    const s = out!.signal!;
    expect(s.status).toBe("OPEN");
    expect(s.mode).toBe("paper");
    expect(s.sl!).toBeLessThan(s.entry!);
    expect(s.tp1!).toBeGreaterThan(s.entry!);
    expect(s.tp3!).toBeGreaterThan(s.tp2!);
    expect(s.reasons![0]).toContain("EMA200");
    expect(ctx.series.h1.some((c) => c.time + HOUR_MS === s.createdAt)).toBe(true);
  });
});

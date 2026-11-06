import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COSTS, judge, metrics, netResultR, replay, splitTrades, type Trade } from "../src/backtest/backtest.js";
import { loadHistory } from "../src/backtest/history.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/signals/engine.v2.js";
import { DAY_MS, H4_MS, HOUR_MS } from "../src/signals/mtf.js";
import type { MarketProvider } from "../src/market/providers/types.js";
import type { Candle, Signal } from "../src/types/index.js";

describe("costs", () => {
  it("fees of 0.1% per side and slippage of 0.05% per fill reduce a +1R BUY", () => {
    // entry 100, stop 98 (risk 2), exit at 102: gross +1R
    const net = netResultR("BUY", 100, 98, 102, DEFAULT_COSTS);
    const entryFill = 100 * 1.0005;
    const exitFill = 102 * 0.9995;
    const expected = (exitFill - entryFill - 0.001 * (entryFill + exitFill)) / 2;
    expect(net).toBeCloseTo(expected, 10);
    expect(net).toBeLessThan(1);
    expect(net).toBeCloseTo(0.85, 2);
  });

  it("works for SELL, and a stop-out loses a little more than 1R", () => {
    expect(netResultR("SELL", 100, 102, 98, DEFAULT_COSTS)).toBeCloseTo(0.85, 2);
    expect(netResultR("BUY", 100, 98, 98, DEFAULT_COSTS)).toBeLessThan(-1);
  });

  it("no costs gives exactly the gross R", () => {
    expect(netResultR("BUY", 100, 98, 104, { feePerSide: 0, slippage: 0 })).toBe(2);
  });
});

const trade = (netR: number, closedAt: number, createdAt = 0, tp1 = netR > 0): Trade => ({
  signal: { createdAt, closedAt, statusHistory: tp1 ? [{ status: "TP1_HIT", at: 0, price: 1, resultR: 1 }] : [] } as unknown as Signal,
  exitStatus: "SL_HIT", exitPrice: 1, grossR: netR, netR,
});

describe("metrics", () => {
  it("win rate, average R, profit factor, drawdown, trades per month and longest losing streak", () => {
    const trades = [trade(2, 1), trade(-1, 2), trade(-1, 3), trade(-1, 4), trade(3, 5), trade(-1, 6)];
    const m = metrics(trades, 2);
    expect(m.trades).toBe(6);
    expect(m.winRate).toBe(33.33); // 2 of 6 reached TP1
    expect(m.profitableRate).toBe(33.33);
    expect(m.avgR).toBe(0.17); // 1 / 6
    expect(m.profitFactor).toBe(1.25); // 5 / 4
    expect(m.maxDrawdownR).toBe(3); // 2 -> -1 is a fall of 3
    expect(m.tradesPerMonth).toBe(3);
    expect(m.longestLosingStreak).toBe(3);
  });

  it("handles no trades", () => {
    expect(metrics([], 3)).toMatchObject({ trades: 0, winRate: null, avgR: null, profitFactor: null, maxDrawdownR: 0, longestLosingStreak: 0 });
  });
});

describe("verdict", () => {
  const t = { minProfitFactor: 1.3, minTrades: 30, maxDrawdownR: 10 };
  const good = { trades: 30, winRate: 50, profitableRate: 50, avgR: 0.3, profitFactor: 1.3, maxDrawdownR: 10, tradesPerMonth: 2, longestLosingStreak: 4 };

  it("PASS exactly at the thresholds", () => {
    expect(judge(good, t).verdict).toBe("PASS");
  });
  it("FAIL when any one check is just outside", () => {
    expect(judge({ ...good, profitFactor: 1.29 }, t).verdict).toBe("FAIL");
    expect(judge({ ...good, trades: 29 }, t).verdict).toBe("FAIL");
    expect(judge({ ...good, maxDrawdownR: 10.01 }, t).verdict).toBe("FAIL");
  });
  it("lists which check failed", () => {
    const v = judge({ ...good, trades: 5 }, t);
    expect(v.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["trades"]);
  });
  it("thresholds are settings: a stricter profit factor fails the same numbers", () => {
    expect(judge(good, { ...t, minProfitFactor: 2 }).verdict).toBe("FAIL");
  });
});

describe("split", () => {
  it("puts signals created before the split time in-sample and the rest out-of-sample", () => {
    const { inSample, outOfSample } = splitTrades([trade(1, 5, 10), trade(1, 5, 69), trade(1, 5, 70), trade(1, 5, 99)], 70);
    expect(inSample.map((t) => t.signal.createdAt)).toEqual([10, 69]);
    expect(outOfSample.map((t) => t.signal.createdAt)).toEqual([70, 99]);
  });
});

function syntheticSeries(days: number, drift: number) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const h1: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < days * 24; i++) {
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

describe("replay", () => {
  const config = { ...DEFAULT_ENGINE_CONFIG, minScore: 40 };

  it("produces closed trades with net R below gross R when there are costs", () => {
    const series = syntheticSeries(300, 0.0003);
    const { trades } = replay({ symbol: "BTCUSDT", series, startTime: 220 * DAY_MS, config, timeStopHours: 48 });
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(t.signal.closedAt).toBeGreaterThan(t.signal.createdAt);
      expect(["TP3_HIT", "SL_HIT", "BREAKEVEN_EXIT", "TIME_EXIT"]).toContain(t.exitStatus);
    }
    const stops = trades.filter((t) => t.exitStatus === "SL_HIT");
    for (const t of stops) expect(t.netR).toBeLessThan(t.grossR);
  });

  it("has no lookahead: cutting off the future does not change earlier signals", () => {
    const full = syntheticSeries(300, 0.0003);
    const cut = { h1: full.h1.slice(0, 280 * 24), h4: full.h4.slice(0, 280 * 6), d1: full.d1.slice(0, 280) };
    const run = (series: typeof full) =>
      replay({ symbol: "BTCUSDT", series, startTime: 220 * DAY_MS, config, timeStopHours: 48 }).trades.filter((t) => t.signal.createdAt < 270 * DAY_MS && t.signal.closedAt! < 270 * DAY_MS);
    const a = run(full).map((t) => [t.signal.createdAt, t.signal.side, t.signal.entry, t.signal.sl, t.exitStatus, t.netR]);
    const b = run(cut).map((t) => [t.signal.createdAt, t.signal.side, t.signal.entry, t.signal.sl, t.exitStatus, t.netR]);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("never opens two signals in the same direction at once", () => {
    const series = syntheticSeries(300, 0.0003);
    const { trades } = replay({ symbol: "BTCUSDT", series, startTime: 220 * DAY_MS, config, timeStopHours: 48 });
    for (const side of ["BUY", "SELL"]) {
      const mine = trades.filter((t) => t.signal.side === side).sort((x, y) => x.signal.createdAt - y.signal.createdAt);
      for (let i = 1; i < mine.length; i++) expect(mine[i]!.signal.createdAt).toBeGreaterThanOrEqual(mine[i - 1]!.signal.closedAt!);
    }
  });
});

describe("history paging", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tradelens-history-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const all: Candle[] = Array.from({ length: 450 }, (_, i) => ({ time: i * HOUR_MS, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: true }));
  function provider() {
    const calls: number[] = [];
    const p = {
      name: "okx",
      getCandlesBefore: async (_s: string, _i: string, end: number, limit: number) => {
        calls.push(end);
        return all.filter((c) => c.time < end).slice(-limit);
      },
    } as unknown as MarketProvider;
    return { p, calls };
  }

  it("pages backwards 100 at a time, returns oldest first without gaps, and caches the result", async () => {
    const { p, calls } = provider();
    const base = { provider: p, symbol: "BTCUSDT" as const, interval: "1h" as const, startMs: 50 * HOUR_MS, endMs: 450 * HOUR_MS, cacheDir: dir };
    const first = await loadHistory(base);
    expect(first[0]!.time).toBe(50 * HOUR_MS);
    expect(first[first.length - 1]!.time).toBe(449 * HOUR_MS);
    expect(first).toHaveLength(400);
    const firstCalls = calls.length;
    expect(firstCalls).toBeGreaterThanOrEqual(4);

    const again = await loadHistory(base); // everything is cached: no new requests
    expect(again).toHaveLength(400);
    expect(calls.length).toBe(firstCalls);
  });

  it("refuses a provider that cannot page (Kraken)", async () => {
    await expect(loadHistory({ provider: { name: "kraken" } as unknown as MarketProvider, symbol: "BTCUSDT", interval: "1h", startMs: 0, endMs: HOUR_MS, cacheDir: dir })).rejects.toThrow(/cannot page/);
  });
});

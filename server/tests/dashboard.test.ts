import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { PivotsResult } from "../src/analysis/pivots.js";
import type { Symbol, Timeframe } from "../src/config/symbols.js";
import { DashboardService, nearestPivots, trendFrom, type DashboardDeps } from "../src/dashboard/service.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { MarketDataError } from "../src/market/binanceRest.js";
import { DEFAULT_SETTINGS } from "../src/settings/schema.js";
import type { Candle, PivotLevels, Settings, Signal } from "../src/types/index.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0); // 2026-11-06 12:00 UTC
const LEVELS: PivotLevels = { S3: 70, S2: 80, S1: 90, P: 100, R1: 110, R2: 120, R3: 130 };

const hourly = (closes: number[], formingLast?: number): Candle[] => {
  const list: Candle[] = closes.map((close, i) => ({
    time: NOW - (closes.length - i + (formingLast === undefined ? 0 : 1)) * HOUR,
    open: close, high: close + 1, low: close - 1, close, volume: 1, closed: true,
  }));
  if (formingLast !== undefined) list.push({ time: NOW - HOUR, open: formingLast, high: formingLast, low: formingLast, close: formingLast, volume: 1, closed: false });
  return list;
};
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const rising = range(1, 200);
const falling = range(1, 200).reverse();
const flat = Array(200).fill(100);

const signal = (n: number, symbol: Symbol, side: "BUY" | "SELL", createdAt: number): Signal => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  symbol, side, timeframe: "1h", price: 100 + n, trigger: side === "BUY" ? "ema_cross_up" : "ema_cross_down",
  levels: { S1: 90, R2: 120, pivots: LEVELS }, indicators: { emaFast: 1, emaSlow: 2, rsi: 50 }, reason: `signal ${n}`, createdAt,
});

const settings = (over: Partial<Settings["symbols"]> = {}, timeframe: Timeframe = "1h"): Pick<{ get(): Settings }, "get"> => ({
  get: () => ({ ...structuredClone(DEFAULT_SETTINGS), symbols: { enabled: ["BTCUSDT", "SOLUSDT", "ETHUSDT"], ...over }, signals: { ...DEFAULT_SETTINGS.signals, timeframe } }) as Settings,
});

const fakeSignals = (all: Signal[]) => ({
  list: ({ symbol, limit = 50 }: { symbol?: string; limit?: number } = {}) =>
    all.filter((s) => !symbol || s.symbol === symbol).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
});

interface Fixture { price?: number; series?: number[]; forming?: number; pivots?: PivotLevels }
function marketFor(fixtures: Partial<Record<Symbol, Fixture>>) {
  return {
    getPrice: vi.fn(async (symbol: Symbol) => {
      const price = fixtures[symbol]?.price ?? 105;
      return { symbol, price, change24h: 2.5, changePercent24h: 1.25, source: "binance" as const };
    }),
    getCandles: vi.fn(async (symbol: Symbol, interval: Timeframe) => {
      const f = fixtures[symbol] ?? {};
      return { symbol, interval, source: "binance" as const, candles: hourly(f.series ?? flat, f.forming) };
    }),
    getPivots: vi.fn(async (symbol: Symbol): Promise<PivotsResult> => ({ symbol, basis: "daily", date: "2026-11-05", ...(fixtures[symbol]?.pivots ?? LEVELS) })),
  };
}

const make = (market: ReturnType<typeof marketFor>, over: Partial<DashboardDeps> = {}) =>
  new DashboardService({ market, settings: settings(), signals: fakeSignals([]), now: () => NOW, ...over });

describe("trendFrom", () => {
  it("Bullish when EMA fast is above EMA slow, Bearish when below", () => {
    expect(trendFrom(rising, 20, 50)).toBe("Bullish");
    expect(trendFrom(falling, 20, 50)).toBe("Bearish");
  });
  it("Neutral when equal, and when there is too little data", () => {
    expect(trendFrom(flat, 20, 50)).toBe("Neutral");
    expect(trendFrom(range(1, 30), 20, 50)).toBe("Neutral"); // slow EMA not computable yet
    expect(trendFrom([], 20, 50)).toBe("Neutral");
  });
});

describe("nearestPivots", () => {
  it("finds the closest level above and the closest at or below", () => {
    expect(nearestPivots(105, LEVELS)).toEqual({ above: { name: "R1", value: 110 }, below: { name: "P", value: 100 } });
    expect(nearestPivots(95, LEVELS)).toEqual({ above: { name: "P", value: 100 }, below: { name: "S1", value: 90 } });
    expect(nearestPivots(119.99, LEVELS)).toEqual({ above: { name: "R2", value: 120 }, below: { name: "R1", value: 110 } });
  });
  it("a price exactly on a level counts that level as below", () => {
    expect(nearestPivots(100, LEVELS)).toEqual({ above: { name: "R1", value: 110 }, below: { name: "P", value: 100 } });
  });
  it("has no level above beyond R3 and none below under S3", () => {
    expect(nearestPivots(135, LEVELS)).toEqual({ above: null, below: { name: "R3", value: 130 } });
    expect(nearestPivots(65, LEVELS)).toEqual({ above: { name: "S3", value: 70 }, below: null });
  });
});

describe("DashboardService", () => {
  it("builds one entry per enabled symbol with price, change, trend, pivots, signal and sparkline", async () => {
    const market = marketFor({
      BTCUSDT: { price: 105, series: rising },
      SOLUSDT: { price: 95, series: falling },
      ETHUSDT: { price: 135, series: flat },
    });
    const signals = [signal(1, "BTCUSDT", "BUY", NOW - 2 * HOUR), signal(2, "SOLUSDT", "SELL", NOW - 5 * HOUR)];
    const out = await make(market, { signals: fakeSignals(signals) }).get();

    expect(out.generatedAt).toBe(NOW);
    expect(out.symbols.map((s) => s.symbol)).toEqual(["BTCUSDT", "SOLUSDT", "ETHUSDT"]);
    const [btc, sol, eth] = out.symbols;
    expect(btc).toMatchObject({ price: 105, change24h: 2.5, changePercent24h: 1.25, trend: "Bullish", pivotAbove: { name: "R1", value: 110 }, pivotBelow: { name: "P", value: 100 } });
    expect(sol).toMatchObject({ price: 95, trend: "Bearish", pivotAbove: { name: "P", value: 100 }, pivotBelow: { name: "S1", value: 90 } });
    expect(eth).toMatchObject({ price: 135, trend: "Neutral", pivotAbove: null, pivotBelow: { name: "R3", value: 130 } });
    expect(btc!.lastSignal?.id).toBe(signals[0]!.id);
    expect(sol!.lastSignal?.side).toBe("SELL");
    expect(eth!.lastSignal).toBeNull();
  });

  it("sparkline is the closes of the last 24 closed 1h candles, ignoring the forming candle", async () => {
    const out = await make(marketFor({ BTCUSDT: { series: rising, forming: 999 } }), { settings: settings({ enabled: ["BTCUSDT"] }) }).get();
    expect(out.symbols[0]!.sparkline).toEqual(range(177, 200));
    expect(out.symbols[0]!.sparkline).toHaveLength(24);
  });

  it("trend uses the strategy timeframe when it is not 1h", async () => {
    const market = marketFor({ BTCUSDT: { series: rising } });
    await make(market, { settings: settings({ enabled: ["BTCUSDT"] }, "4h") }).get();
    expect(market.getCandles).toHaveBeenCalledWith("BTCUSDT", "1h", 200);
    expect(market.getCandles).toHaveBeenCalledWith("BTCUSDT", "4h", 200);
  });

  it("counts today's signals (UTC) and lists the 5 newest across symbols", async () => {
    const all = [
      signal(1, "BTCUSDT", "BUY", Date.UTC(2026, 10, 5, 23, 0)), // yesterday
      signal(2, "BTCUSDT", "BUY", Date.UTC(2026, 10, 6, 1, 0)),
      signal(3, "SOLUSDT", "SELL", Date.UTC(2026, 10, 6, 3, 0)),
      signal(4, "ETHUSDT", "SELL", Date.UTC(2026, 10, 6, 5, 0)),
      signal(5, "BTCUSDT", "BUY", Date.UTC(2026, 10, 6, 7, 0)),
      signal(6, "SOLUSDT", "BUY", Date.UTC(2026, 10, 6, 9, 0)),
      signal(7, "ETHUSDT", "BUY", Date.UTC(2026, 10, 6, 11, 0)),
    ];
    const out = await make(marketFor({}), { signals: fakeSignals(all) }).get();
    expect(out.signals.today).toEqual({ total: 6, buy: 4, sell: 2 });
    expect(out.signals.recent.map((s) => s.id.slice(-1))).toEqual(["7", "6", "5", "4", "3"]);
  });

  it("only includes enabled symbols", async () => {
    const out = await make(marketFor({}), { settings: settings({ enabled: ["SOLUSDT"] }) }).get();
    expect(out.symbols.map((s) => s.symbol)).toEqual(["SOLUSDT"]);
  });

  it("caches the response for 5 seconds, then rebuilds", async () => {
    let now = NOW;
    const market = marketFor({});
    const service = make(market, { now: () => now });
    const first = await service.get();
    now += 4_999;
    const second = await service.get();
    expect(second).toBe(first);
    expect(market.getPrice).toHaveBeenCalledTimes(3); // 3 symbols, built once

    now += 1; // 5 seconds elapsed
    const third = await service.get();
    expect(third).not.toBe(first);
    expect(third.generatedAt).toBe(now);
    expect(market.getPrice).toHaveBeenCalledTimes(6);
  });

  it("shares one build between concurrent requests", async () => {
    const market = marketFor({});
    const service = make(market);
    await Promise.all([service.get(), service.get(), service.get()]);
    expect(market.getPrice).toHaveBeenCalledTimes(3);
  });

  it("falls back to the last candle close when the ticker fails, and leaves pivots null when they fail", async () => {
    const market = marketFor({ BTCUSDT: { series: [10, 20, 30] } });
    market.getPrice.mockRejectedValue(new MarketDataError(502, "MARKET_DATA_UNAVAILABLE", "ticker down"));
    market.getPivots.mockRejectedValue(new MarketDataError(502, "MARKET_DATA_UNAVAILABLE", "pivots down"));
    const out = await make(market, { settings: settings({ enabled: ["BTCUSDT"] }) }).get();
    expect(out.symbols[0]).toMatchObject({ price: 30, change24h: null, changePercent24h: null, pivotAbove: null, pivotBelow: null });
    expect(out.symbols[0]!.sparkline).toEqual([10, 20, 30]);
  });

  it("throws the real error when nothing at all could be loaded, and does not cache it", async () => {
    const market = marketFor({});
    const blocked = new MarketDataError(502, "MARKET_DATA_BLOCKED", "Market data blocked from this network.");
    market.getPrice.mockRejectedValue(blocked);
    market.getCandles.mockRejectedValue(blocked);
    market.getPivots.mockRejectedValue(blocked);
    const service = make(market);
    await expect(service.get()).rejects.toBe(blocked);

    market.getPrice.mockImplementation(async (symbol: Symbol) => ({ symbol, price: 105, change24h: 0, changePercent24h: 0, source: "binance" as const }));
    market.getCandles.mockImplementation(async (symbol: Symbol, interval: Timeframe) => ({ symbol, interval, source: "binance" as const, candles: hourly(flat) }));
    market.getPivots.mockImplementation(async (symbol: Symbol) => ({ symbol, basis: "daily" as const, date: "x", ...LEVELS }));
    expect((await service.get()).symbols).toHaveLength(3); // recovered immediately: the failure was not cached
  });
});

describe("GET /api/dashboard", () => {
  const logger = createLogger({ level: "silent", pretty: false });

  it("returns the dashboard JSON", async () => {
    const dashboard = make(marketFor({ BTCUSDT: { price: 105, series: rising } }));
    const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, dashboard });
    const res = await request(app).get("/api/dashboard").expect(200);
    expect(res.body.generatedAt).toBe(NOW);
    expect(res.body.symbols).toHaveLength(3);
    expect(res.body.symbols[0]).toMatchObject({ symbol: "BTCUSDT", trend: "Bullish" });
    expect(res.body.signals).toEqual({ today: { total: 0, buy: 0, sell: 0 }, recent: [] });
  });

  it("maps a total failure to the central error shape", async () => {
    const market = marketFor({});
    const err = new MarketDataError(502, "MARKET_DATA_BLOCKED", "Market data blocked from this network. Set MARKET_PROVIDER to another provider.");
    market.getPrice.mockRejectedValue(err);
    market.getCandles.mockRejectedValue(err);
    market.getPivots.mockRejectedValue(err);
    const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, dashboard: make(market) });
    const res = await request(app).get("/api/dashboard").expect(502);
    expect(res.body.error.code).toBe("MARKET_DATA_BLOCKED");
  });
});

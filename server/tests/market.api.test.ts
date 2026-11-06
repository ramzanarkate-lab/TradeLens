import { EventEmitter } from "node:events";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { BLOCKED_MESSAGE, MarketDataError } from "../src/market/binanceRest.js";
import { CandleCache } from "../src/market/cache.js";
import { MarketService } from "../src/market/service.js";
import type { Candle } from "../src/types/index.js";

const logger = createLogger({ level: "silent", pretty: false });
const HOUR = 3_600_000;
const MIN = 60_000;

const candle = (time: number, close = 1, closed = true): Candle => ({ time, open: 1, high: 2, low: 0.5, close, volume: 1, closed });

function setup(rest: Record<string, unknown>, stream?: unknown, hub?: { broadcast: ReturnType<typeof vi.fn> }) {
  const market = new MarketService({
    rest: rest as never,
    cache: new CandleCache(),
    stream: stream as never,
    hub,
    logger,
  });
  const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, market });
  return { app, market };
}

describe("GET /api/candles", () => {
  it("returns candles from the provider and validates the query", async () => {
    const fetchKlines = vi.fn(async () => [candle(1000, 5)]);
    const { app } = setup({ fetchKlines });

    const res = await request(app).get("/api/candles?symbol=BTCUSDT&interval=1h&limit=5").expect(200);
    expect(res.body).toEqual({ symbol: "BTCUSDT", interval: "1h", source: "binance", candles: [candle(1000, 5)] });
    expect(fetchKlines).toHaveBeenCalledWith("BTCUSDT", "1h", 5);

    // defaults
    await request(app).get("/api/candles?symbol=ETHUSDT").expect(200);
    expect(fetchKlines).toHaveBeenLastCalledWith("ETHUSDT", "1h", 200);

    for (const bad of ["symbol=DOGEUSDT", "", "symbol=BTCUSDT&interval=5m", "symbol=BTCUSDT&limit=1001", "symbol=BTCUSDT&limit=0", "symbol=BTCUSDT&limit=abc"]) {
      const r = await request(app).get(`/api/candles?${bad}`).expect(400);
      expect(r.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("serves repeat requests from the cache", async () => {
    const fetchKlines = vi.fn(async () => [candle(1000)]);
    const { app } = setup({ fetchKlines });
    await request(app).get("/api/candles?symbol=BTCUSDT&interval=1h&limit=5").expect(200);
    await request(app).get("/api/candles?symbol=BTCUSDT&interval=1h&limit=5").expect(200);
    expect(fetchKlines).toHaveBeenCalledTimes(1);
  });

  it("surfaces the blocked error clearly when there is no fallback data", async () => {
    const fetchKlines = vi.fn(async () => {
      throw new MarketDataError(502, "MARKET_DATA_BLOCKED", BLOCKED_MESSAGE);
    });
    const { app } = setup({ fetchKlines });
    const res = await request(app).get("/api/candles?symbol=BTCUSDT&interval=1h&limit=5").expect(502);
    expect(res.body).toEqual({ error: { code: "MARKET_DATA_BLOCKED", message: BLOCKED_MESSAGE } });
  });

  it("falls back to candles aggregated from the 1m feed when REST fails", async () => {
    const stream = Object.assign(new EventEmitter(), {
      getLatest: () => undefined,
      getStatus: () => "Live" as const,
    });
    const fetchKlines = vi.fn(async () => {
      throw new MarketDataError(502, "MARKET_DATA_UNAVAILABLE", "down");
    });
    const { app, market } = setup({ fetchKlines }, stream);
    market.start();

    const start = 100 * HOUR;
    for (let i = 0; i < 60; i++) stream.emit("candle", "BTCUSDT", { ...candle(start + i * MIN, 10 + i), open: 10 + i, high: 100, low: 1, volume: 2 });

    const res = await request(app).get("/api/candles?symbol=BTCUSDT&interval=1h&limit=5").expect(200);
    expect(res.body.source).toBe("aggregated");
    expect(res.body.candles).toEqual([{ time: start, open: 10, high: 100, low: 1, close: 69, volume: 120, closed: true }]);

    // no 1m data for another symbol -> original error
    await request(app).get("/api/candles?symbol=SOLUSDT&interval=1h").expect(502);
  });
});

describe("GET /api/price", () => {
  it("returns price and 24h change from the ticker", async () => {
    const fetchTicker24h = vi.fn(async () => ({ symbol: "BTCUSDT", price: 67000, change24h: -100, changePercent24h: -0.15 }));
    const { app } = setup({ fetchTicker24h });
    const res = await request(app).get("/api/price?symbol=BTCUSDT").expect(200);
    expect(res.body).toEqual({ symbol: "BTCUSDT", price: 67000, change24h: -100, changePercent24h: -0.15, source: "binance" });
    await request(app).get("/api/price?symbol=DOGEUSDT").expect(400);
    await request(app).get("/api/price").expect(400);
  });

  it("falls back to the live stream price when the ticker is unavailable", async () => {
    const stream = Object.assign(new EventEmitter(), {
      getLatest: (s: string) => (s === "BTCUSDT" ? candle(1, 66000, false) : undefined),
      getStatus: () => "Live" as const,
    });
    const fetchTicker24h = vi.fn(async () => {
      throw new MarketDataError(502, "MARKET_DATA_BLOCKED", BLOCKED_MESSAGE);
    });
    const { app } = setup({ fetchTicker24h }, stream);
    const res = await request(app).get("/api/price?symbol=BTCUSDT").expect(200);
    expect(res.body).toEqual({ symbol: "BTCUSDT", price: 66000, change24h: null, changePercent24h: null, source: "stream" });
    await request(app).get("/api/price?symbol=ETHUSDT").expect(502);
  });
});

describe("hub publishing", () => {
  it('publishes candles to "candles:<symbol>" and feed status to "status"', () => {
    const stream = Object.assign(new EventEmitter(), { getLatest: () => undefined, getStatus: () => "Live" as const });
    const hub = { broadcast: vi.fn(() => 1) };
    const { market } = setup({}, stream, hub);
    market.start();

    const c = candle(5, 3, false);
    stream.emit("candle", "SOLUSDT", c);
    stream.emit("status", "Reconnecting");

    expect(hub.broadcast).toHaveBeenCalledWith("candles:SOLUSDT", { symbol: "SOLUSDT", interval: "1m", candle: c });
    expect(hub.broadcast).toHaveBeenCalledWith("status", { feed: "Reconnecting" });
  });
});

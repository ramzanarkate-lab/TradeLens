import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { MarketDataError } from "../src/market/binanceRest.js";
import { MarketPoller } from "../src/market/poller.js";
import { ProviderRegistry } from "../src/market/providerRegistry.js";
import type { MarketProvider, ProviderName } from "../src/market/providers/types.js";
import type { Candle } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
const candle = (time: number, closed = false): Candle => ({ time, open: 1, high: 2, low: 1, close: 1.5, volume: 3, closed });

function provider(name: ProviderName, run: () => Promise<Candle[]>): MarketProvider {
  return {
    name,
    getCandles: vi.fn(run),
    getTicker: vi.fn(async () => ({ price: 1.5, change24h: 0.5, changePercent24h: 2 })),
    ping: vi.fn(async () => ({ ok: true, detail: "OK", status: 200 })),
  };
}
const failing = (code: string) => async (): Promise<Candle[]> => {
  throw new MarketDataError(502, code, "down");
};

describe("auto mode order", () => {
  it("tries bybit, okx, kraken, binance in that order", async () => {
    const pings: string[] = [];
    const mk = (name: ProviderName, ok: boolean): MarketProvider => ({
      ...provider(name, async () => []),
      ping: async () => {
        pings.push(name);
        return { ok, detail: ok ? "OK" : "x" };
      },
    });
    const reg = new ProviderRegistry({ mode: "auto", logger: silent, providers: [mk("binance", true), mk("kraken", false), mk("okx", false), mk("bybit", false)] });
    expect(await reg.init()).toBe("binance");
    expect(pings).toEqual(["bybit", "okx", "kraken", "binance"]);
  });

  it("explains why prices are missing without any secret", async () => {
    const reg = new ProviderRegistry({ mode: "okx", logger: silent, providers: [provider("okx", failing("MARKET_DATA_BLOCKED"))] });
    await reg.init();
    expect(reg.failureReason()).toBeNull();
    await reg.fetchKlines("BTCUSDT", "1m", 1).catch(() => undefined);
    expect(reg.failureReason()).toBe("Market data blocked from this server");
  });
});

describe("poller sends the 24h ticker with the candle", () => {
  it("emits (symbol, candle, ticker) for each symbol every cycle", async () => {
    const source = {
      fetchKlines: vi.fn(async () => [candle(60_000)]),
      fetchTicker24h: vi.fn(async () => ({ price: 1.5, change24h: 0.5, changePercent24h: 2 })),
    };
    const poller = new MarketPoller({ source, logger: silent });
    const got: Array<[string, unknown]> = [];
    poller.on("candle", (symbol: string, _c: Candle, ticker: unknown) => got.push([symbol, ticker]));
    await poller.pollOnce();
    expect(got.map((g) => g[0]).sort()).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(got[0]![1]).toEqual({ price: 1.5, change24h: 0.5, changePercent24h: 2 });
  });

  it("a failing ticker does not stop the candle", async () => {
    const source = {
      fetchKlines: vi.fn(async () => [candle(60_000)]),
      fetchTicker24h: vi.fn(async () => {
        throw new Error("ticker down");
      }),
    };
    const poller = new MarketPoller({ source, logger: silent });
    const seen: string[] = [];
    poller.on("candle", (s: string) => seen.push(s));
    await poller.pollOnce();
    expect(seen).toHaveLength(3);
  });
});

describe("/health live flag", () => {
  function build(now: () => number, ok: () => boolean) {
    const source = {
      fetchKlines: vi.fn(async () => {
        if (!ok()) throw new Error("down");
        return [candle(60_000)];
      }),
    };
    const poller = new MarketPoller({ source, logger: silent, now });
    const app = createApp({
      env: { CORS_ORIGINS: [] },
      logger: silent,
      clientCount: () => 0,
      marketHealth: () => ({
        status: poller.getStatus(),
        provider: "okx",
        lastPoll: Object.fromEntries(Object.entries(poller.lastPolls()).map(([s, t]) => [s, t ? new Date(t).toISOString() : null])),
        reason: poller.getStatus() === "Live" ? null : "Market data blocked from this server",
      }),
    });
    return { poller, app };
  }

  it("reports live=true after an update and live=false after 15 seconds without one", async () => {
    let t = 1_000_000;
    let up = true;
    const { poller, app } = build(() => t, () => up);
    await poller.pollOnce();
    let res = await request(app).get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", activeProvider: "okx", live: true, reason: null });
    expect(res.body.lastPriceUpdate.BTCUSDT).toBe(new Date(1_000_000).toISOString());

    up = false;
    t += 15_000;
    await poller.pollOnce();
    expect((await request(app).get("/health")).body.live).toBe(true); // exactly 15 s is still live

    t += 1;
    await poller.pollOnce();
    res = await request(app).get("/health").expect(200);
    expect(res.body.live).toBe(false);
    expect(res.body.reason).toBe("Market data blocked from this server");
  });
});

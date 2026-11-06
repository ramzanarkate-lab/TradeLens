import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { MarketDataError } from "../src/market/binanceRest.js";
import { MarketPoller, LIVE_WITHIN_MS } from "../src/market/poller.js";
import { FAILURES_BEFORE_SWITCH, ProviderRegistry, redactEnvSecrets } from "../src/market/providerRegistry.js";
import { BinanceProvider } from "../src/market/providers/binance.js";
import { BybitProvider } from "../src/market/providers/bybit.js";
import { KrakenProvider } from "../src/market/providers/kraken.js";
import { OkxProvider } from "../src/market/providers/okx.js";
import { providerSymbol } from "../src/market/providers/symbolMap.js";
import type { MarketProvider, ProviderName } from "../src/market/providers/types.js";
import type { Candle } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 6, 10, 0, 0);
const NOW = T0 + HOUR + 5_000; // the candle at T0 has closed, the next one is forming

/** fetch that answers with `body` and records the URLs it was called with. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request) => json(body, status)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const urlOf = (f: ReturnType<typeof fakeFetch>, call = 0) => String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[call]![0]);

const EXPECTED: Candle = { time: T0, open: 100, high: 110, low: 90, close: 105, volume: 12.5, closed: true };

describe("providers map their responses to Candle", () => {
  it("Binance", async () => {
    const f = fakeFetch([[T0, "100", "110", "90", "105", "12.5", T0 + HOUR - 1, "0", 1, "0", "0", "0"]]);
    const p = new BinanceProvider({ baseUrl: "https://binance.test", fetchFn: f, now: () => NOW });
    expect(await p.getCandles("BTCUSDT", "1h", 1)).toEqual([EXPECTED]);
    expect(urlOf(f)).toBe("https://binance.test/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1");
  });

  it("Bybit (newest first -> oldest first, strings -> numbers)", async () => {
    const f = fakeFetch({
      retCode: 0,
      result: { list: [[String(T0 + HOUR), "105", "106", "104", "105.5", "3", "0"], [String(T0), "100", "110", "90", "105", "12.5", "0"]] },
    });
    const p = new BybitProvider({ baseUrl: "https://bybit.test", fetchFn: f, now: () => NOW });
    const candles = await p.getCandles("BTCUSDT", "1h", 2);
    expect(candles[0]).toEqual(EXPECTED);
    expect(candles[1]).toMatchObject({ time: T0 + HOUR, close: 105.5, closed: false });
    expect(urlOf(f)).toBe("https://bybit.test/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=2");
  });

  it("OKX (newest first, 1H bar, BTC-USDT)", async () => {
    const f = fakeFetch({ code: "0", data: [[String(T0 + HOUR), "105", "106", "104", "105.5", "3", "0", "0", "0"], [String(T0), "100", "110", "90", "105", "12.5", "0", "0", "1"]] });
    const p = new OkxProvider({ baseUrl: "https://okx.test", fetchFn: f, now: () => NOW });
    const candles = await p.getCandles("BTCUSDT", "1h", 2);
    expect(candles[0]).toEqual(EXPECTED);
    expect(candles[1]!.closed).toBe(false);
    expect(urlOf(f)).toBe("https://okx.test/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=2");
  });

  it("Kraken (seconds -> ms, volume is column 6, keeps the newest `limit`)", async () => {
    const f = fakeFetch({
      error: [],
      result: {
        XBTUSDT: [
          [(T0 - HOUR) / 1000, "1", "1", "1", "1", "1", "1", 1],
          [T0 / 1000, "100", "110", "90", "105", "104", "12.5", 7],
          [(T0 + HOUR) / 1000, "105", "106", "104", "105.5", "105", "3", 2],
        ],
        last: T0 / 1000,
      },
    });
    const p = new KrakenProvider({ baseUrl: "https://kraken.test", fetchFn: f, now: () => NOW });
    const candles = await p.getCandles("BTCUSDT", "1h", 2);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual(EXPECTED);
    expect(candles[1]).toMatchObject({ time: T0 + HOUR, closed: false });
    expect(urlOf(f)).toBe("https://kraken.test/0/public/OHLC?pair=XBTUSDT&interval=60");
  });

  it("tickers: price and 24h change from each provider", async () => {
    const bybit = new BybitProvider({ fetchFn: fakeFetch({ retCode: 0, result: { list: [{ lastPrice: "110", prevPrice24h: "100", price24hPcnt: "0.1" }] } }) });
    expect(await bybit.getTicker("BTCUSDT")).toEqual({ price: 110, change24h: 10, changePercent24h: 10 });
    const okx = new OkxProvider({ fetchFn: fakeFetch({ code: "0", data: [{ last: "110", open24h: "100" }] }) });
    expect(await okx.getTicker("ETHUSDT")).toEqual({ price: 110, change24h: 10, changePercent24h: 10 });
    const kraken = new KrakenProvider({ fetchFn: fakeFetch({ error: [], result: { SOLUSDT: { c: ["110", "1"], o: "100" } } }) });
    expect(await kraken.getTicker("SOLUSDT")).toEqual({ price: 110, change24h: 10, changePercent24h: 10 });
    const binance = new BinanceProvider({ fetchFn: fakeFetch({ lastPrice: "110", priceChange: "10", priceChangePercent: "10" }) });
    expect(await binance.getTicker("BTCUSDT")).toEqual({ price: 110, change24h: 10, changePercent24h: 10 });
  });

  it("OKX pages back when more than 300 candles are asked for", async () => {
    const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => [String(start - i * HOUR), "1", "1", "1", "1", "1", "0", "0", "1"]);
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ code: "0", data: page(T0, 300) }))
      .mockResolvedValueOnce(json({ code: "0", data: page(T0 - 300 * HOUR, 100) })) as unknown as typeof fetch;
    const candles = await new OkxProvider({ fetchFn: f, now: () => NOW }).getCandles("BTCUSDT", "1h", 400);
    expect(candles).toHaveLength(400);
    expect(candles[0]!.time).toBeLessThan(candles[399]!.time);
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![0])).toContain(`after=${T0 - 299 * HOUR}`);
  });

  it("403 and 451 are reported as blocked, other failures as unavailable", async () => {
    for (const status of [403, 451]) {
      const p = new BybitProvider({ fetchFn: fakeFetch({}, status) });
      await expect(p.getCandles("BTCUSDT", "1h", 1)).rejects.toMatchObject({ code: "MARKET_DATA_BLOCKED" });
    }
    const down = new OkxProvider({ fetchFn: vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    await expect(down.getCandles("BTCUSDT", "1h", 1)).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
  });

  it("ping never throws", async () => {
    expect(await new BybitProvider({ fetchFn: fakeFetch({}, 451) }).ping()).toMatchObject({ ok: false, detail: "MARKET_DATA_BLOCKED", status: 451 });
    const ok = new BybitProvider({ fetchFn: fakeFetch({ retCode: 0, result: { list: [[String(T0), "1", "1", "1", "1", "1", "0"]] } }) });
    expect((await ok.ping()).ok).toBe(true);
  });
});

describe("symbol mapping", () => {
  it("maps every symbol for every provider in one table", () => {
    const names: ProviderName[] = ["binance", "bybit", "okx", "kraken"];
    expect(names.map((n) => providerSymbol(n, "BTCUSDT"))).toEqual(["BTCUSDT", "BTCUSDT", "BTC-USDT", "XBTUSDT"]);
    expect(names.map((n) => providerSymbol(n, "SOLUSDT"))).toEqual(["SOLUSDT", "SOLUSDT", "SOL-USDT", "SOLUSDT"]);
    expect(names.map((n) => providerSymbol(n, "ETHUSDT"))).toEqual(["ETHUSDT", "ETHUSDT", "ETH-USDT", "ETHUSDT"]);
  });
});

function fake(name: ProviderName, behaviour: () => Promise<Candle[]>, ping = true): MarketProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    getCandles: vi.fn(async () => {
      p.calls++;
      return behaviour();
    }),
    getTicker: vi.fn(async () => ({ price: 1, change24h: 0, changePercent24h: 0 })),
    ping: vi.fn(async () => ({ ok: ping, detail: ping ? "OK" : "MARKET_DATA_BLOCKED", status: ping ? 200 : 451 })),
  };
  return p as unknown as MarketProvider & { calls: number };
}
const blocked = (code = "MARKET_DATA_BLOCKED") => async (): Promise<Candle[]> => {
  throw new MarketDataError(502, code, "blocked");
};
const good = async (): Promise<Candle[]> => [EXPECTED];

describe("provider registry", () => {
  it("auto mode starts with the first provider that answers a ping", async () => {
    const reg = new ProviderRegistry({
      mode: "auto",
      logger: silent,
      providers: [fake("binance", good, true), fake("bybit", good, false), fake("okx", good, true), fake("kraken", good, true)],
    });
    expect(await reg.init()).toBe("okx");
    expect(reg.activeName).toBe("okx");
  });

  it("auto mode switches to the next provider after 3 consecutive 451 or 403 responses", async () => {
    const bybit = fake("bybit", blocked());
    const okx = fake("okx", good);
    const reg = new ProviderRegistry({ mode: "auto", logger: silent, providers: [bybit, okx] });
    await reg.init();
    expect(reg.activeName).toBe("bybit");
    for (let i = 0; i < FAILURES_BEFORE_SWITCH - 1; i++) {
      await expect(reg.fetchKlines("BTCUSDT", "1m", 1)).rejects.toMatchObject({ code: "MARKET_DATA_BLOCKED" });
      expect(reg.activeName).toBe("bybit"); // not yet
    }
    // the third failure switches, and that same request is answered by the new provider
    await expect(reg.fetchKlines("BTCUSDT", "1m", 1)).resolves.toEqual([EXPECTED]);
    expect(reg.activeName).toBe("okx");
    expect(bybit.calls).toBe(3);
  });

  it("a success in between resets the count", async () => {
    let n = 0;
    const flaky = fake("bybit", async () => (++n === 3 ? [EXPECTED] : blocked("MARKET_DATA_UNAVAILABLE")()));
    const reg = new ProviderRegistry({ mode: "auto", logger: silent, providers: [flaky, fake("okx", good)] });
    await reg.init();
    await expect(reg.fetchKlines("BTCUSDT", "1m", 1)).rejects.toBeTruthy();
    await expect(reg.fetchKlines("BTCUSDT", "1m", 1)).rejects.toBeTruthy();
    await reg.fetchKlines("BTCUSDT", "1m", 1); // success
    await expect(reg.fetchKlines("BTCUSDT", "1m", 1)).rejects.toBeTruthy();
    expect(reg.activeName).toBe("bybit");
  });

  it("does not switch for errors that are not blocking, and never when a provider is chosen by name", async () => {
    const reg = new ProviderRegistry({ mode: "auto", logger: silent, providers: [fake("bybit", blocked("MARKET_DATA_REJECTED")), fake("okx", good)] });
    await reg.init();
    for (let i = 0; i < 5; i++) await expect(reg.fetchKlines("BTCUSDT", "1m", 1)).rejects.toBeTruthy();
    expect(reg.activeName).toBe("bybit");

    const fixed = new ProviderRegistry({ mode: "okx", logger: silent, providers: [fake("binance", good), fake("okx", blocked())] });
    await fixed.init();
    for (let i = 0; i < 5; i++) await expect(fixed.fetchKlines("BTCUSDT", "1m", 1)).rejects.toBeTruthy();
    expect(fixed.activeName).toBe("okx");
  });

  it("logs the chosen provider once at startup and each switch", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "info" }, { write: (s: string) => void lines.push(s) });
    const reg = new ProviderRegistry({ mode: "auto", logger, providers: [fake("bybit", blocked()), fake("okx", good)] });
    await reg.init();
    for (let i = 0; i < 3; i++) await reg.fetchKlines("BTCUSDT", "1m", 1).catch(() => undefined);
    expect(lines.filter((l) => l.includes("market provider: bybit"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("switched from bybit to okx"))).toBe(true);
  });
});

describe("poller", () => {
  const minute = (time: number, closed: boolean): Candle => ({ ...EXPECTED, time, closed });

  it("publishes one candle update per symbol per cycle", async () => {
    const source = { fetchKlines: vi.fn(async () => [minute(0, true), minute(60_000, false)]) };
    const poller = new MarketPoller({ source, logger: silent, now: () => 1_000 });
    const seen: string[] = [];
    poller.on("candle", (symbol: string, c: Candle) => seen.push(`${symbol}:${c.time}:${c.closed}`));
    await poller.pollOnce();
    // first ever cycle also announces the closed minute once
    expect(seen.filter((s) => s.startsWith("BTCUSDT"))).toEqual(["BTCUSDT:0:true", "BTCUSDT:60000:false"]);
    seen.length = 0;
    await poller.pollOnce();
    expect(seen.sort()).toEqual(["BTCUSDT:60000:false", "ETHUSDT:60000:false", "SOLUSDT:60000:false"]); // exactly one each
    expect(source.fetchKlines).toHaveBeenCalledTimes(6);
  });

  it("publishes to the hub topic through the market service shape (status + candle events)", async () => {
    const poller = new MarketPoller({ source: { fetchKlines: async () => [minute(60_000, false)] }, logger: silent });
    const events: string[] = [];
    poller.on("status", (s: string) => events.push(s));
    await poller.pollOnce();
    expect(events).toEqual(["Live"]);
    expect(poller.getLatest("BTCUSDT")?.time).toBe(60_000);
  });

  it("is Offline before the first poll, Live after a success, and Offline again after 15 seconds without one", async () => {
    let t = 1_000_000;
    let fail = false;
    const source = {
      fetchKlines: vi.fn(async () => {
        if (fail) throw new Error("down");
        return [minute(0, false)];
      }),
    };
    const poller = new MarketPoller({ source, logger: silent, now: () => t });
    const statuses: string[] = [];
    poller.on("status", (s: string) => statuses.push(s));
    expect(poller.getStatus()).toBe("Offline");
    await poller.pollOnce();
    expect(poller.getStatus()).toBe("Live");

    fail = true;
    t += LIVE_WITHIN_MS; // 15s: still Live
    await poller.pollOnce();
    expect(poller.getStatus()).toBe("Live");
    t += 1; // just over 15s
    await poller.pollOnce();
    expect(poller.getStatus()).toBe("Offline");
    expect(statuses).toEqual(["Live", "Offline"]);

    fail = false; // recovers
    await poller.pollOnce();
    expect(poller.getStatus()).toBe("Live");
  });

  it("one failing symbol does not stop the others, and last poll times are kept per symbol", async () => {
    const source = {
      fetchKlines: vi.fn(async (symbol: string) => {
        if (symbol === "SOLUSDT") throw new Error("nope");
        return [minute(0, false)];
      }),
    };
    const poller = new MarketPoller({ source, logger: silent, now: () => 5_000 });
    await poller.pollOnce();
    expect(poller.lastPolls()).toEqual({ BTCUSDT: 5_000, SOLUSDT: null, ETHUSDT: 5_000 });
  });
});

describe("/health and /api/diagnostics", () => {
  const SECRET = "unit-test-secret-at-least-16-chars";
  const LEAK = "super-secret-token-value-123456";

  function build() {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = LEAK;
    const failing = fake("bybit", async () => {
      throw new MarketDataError(502, "MARKET_DATA_UNAVAILABLE", `request to https://x.test/?key=${LEAK} failed`);
    });
    const registry = new ProviderRegistry({ mode: "auto", logger: silent, providers: [failing, fake("okx", good)], redact: redactEnvSecrets });
    const auth = new AuthService({ secret: SECRET, adminIds: () => ["admin-1"] });
    const app = createApp({
      env: { CORS_ORIGINS: [] },
      logger: silent,
      clientCount: () => 2,
      auth,
      marketHealth: () => ({ status: "Live", provider: registry.activeName, lastPoll: { BTCUSDT: "2026-11-06T10:00:00.000Z" } }),
      diagnostics: { report: () => registry.diagnostics() },
    });
    return { app, registry, restore: () => (prev === undefined ? delete process.env.TELEGRAM_BOT_TOKEN : (process.env.TELEGRAM_BOT_TOKEN = prev)), admin: auth.issue({ id: "admin-1", name: "A" }).token, user: auth.issue({ id: "u", name: "U" }).token };
  }

  it("/health reports the provider, per-symbol poll time and Live status", async () => {
    const { app, restore } = build();
    const res = await request(app).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.activeProvider).toBe("bybit");
    expect(res.body.lastPriceUpdate).toEqual({ BTCUSDT: "2026-11-06T10:00:00.000Z" });
    expect(res.body.live).toBe(true);
    expect(res.body.reason).toBeNull();
    expect(res.body.market).toMatchObject({ status: "Live", provider: "bybit" });
    restore();
  });

  it("diagnostics is admin only, lists providers and errors, and never shows secrets", async () => {
    const { app, registry, restore, admin, user } = build();
    await registry.fetchKlines("BTCUSDT", "1m", 1).catch(() => undefined); // records an error that contains the secret
    await request(app).get("/api/diagnostics").expect(401);
    await request(app).get("/api/diagnostics").set("Authorization", `Bearer ${user}`).expect(403);
    const res = await request(app).get("/api/diagnostics").set("Authorization", `Bearer ${admin}`).expect(200);
    expect(res.body.providers.map((p: { name: string; reachable: boolean; status: number | null }) => [p.name, p.reachable, p.status])).toEqual([["bybit", true, 200], ["okx", true, 200]]);
    expect(res.body.providers[0].testedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(LEAK);
    const health = await request(app).get("/health");
    expect(JSON.stringify(health.body)).not.toContain(LEAK);
    expect(JSON.stringify(health.body)).not.toContain(SECRET);
    restore();
  });

  it("keeps only the last 10 errors", async () => {
    const { registry, restore } = build();
    for (let i = 0; i < 15; i++) await registry.fetchKlines("BTCUSDT", "1m", 1).catch(() => undefined);
    expect((await registry.diagnostics()).errors.length).toBeLessThanOrEqual(10);
    restore();
  });
});

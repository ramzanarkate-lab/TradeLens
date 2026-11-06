import { describe, expect, it, vi } from "vitest";
import { BLOCKED_MESSAGE, BinanceRest, MarketDataError } from "../src/market/binanceRest.js";

const NOW = 1_700_000_000_000;
const row = (time: number, closeTime: number) => [time, "100.5", "110", "99.5", "105.25", "12.5", closeTime, "0", 10, "0", "0", "0"];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeRest(fetchFn: typeof fetch, extra = {}) {
  const sleeps: number[] = [];
  const rest = new BinanceRest({
    baseUrl: "https://example.test/",
    fetchFn,
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { rest, sleeps };
}

describe("BinanceRest.fetchKlines", () => {
  it("maps kline rows to candles with numeric fields and closed flag", async () => {
    const fetchFn = vi.fn(async () => json([row(NOW - 7_200_000, NOW - 3_600_001), row(NOW - 3_600_000, NOW + 1000)]));
    const { rest } = makeRest(fetchFn as unknown as typeof fetch);

    const candles = await rest.fetchKlines("BTCUSDT", "1h", 2);

    expect(candles).toEqual([
      { time: NOW - 7_200_000, open: 100.5, high: 110, low: 99.5, close: 105.25, volume: 12.5, closed: true },
      { time: NOW - 3_600_000, open: 100.5, high: 110, low: 99.5, close: 105.25, volume: 12.5, closed: false },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.test/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("caps the limit at 1000", async () => {
    const fetchFn = vi.fn(async () => json([]));
    const { rest } = makeRest(fetchFn as unknown as typeof fetch);
    await rest.fetchKlines("BTCUSDT", "1h", 5000);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain("limit=1000");
  });

  it("retries twice with backoff on 5xx, then succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json([row(NOW - 60_000, NOW - 1)]));
    const { rest, sleeps } = makeRest(fetchFn as unknown as typeof fetch);

    const candles = await rest.fetchKlines("ETHUSDT", "15m", 1);

    expect(candles).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([300, 600]);
  });

  it("gives up after 3 attempts on persistent 5xx", async () => {
    const fetchFn = vi.fn(async () => json({}, 500));
    const { rest } = makeRest(fetchFn as unknown as typeof fetch);
    await expect(rest.fetchKlines("BTCUSDT", "1h", 1)).rejects.toMatchObject({ code: "MARKET_DATA_UNAVAILABLE" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([451, 403])("HTTP %i returns the clear blocked error without retrying", async (status) => {
    const fetchFn = vi.fn(async () => json({ msg: "blocked" }, status));
    const { rest } = makeRest(fetchFn as unknown as typeof fetch);
    const err = await rest.fetchKlines("BTCUSDT", "1h", 1).catch((e) => e);
    expect(err).toBeInstanceOf(MarketDataError);
    expect(err.code).toBe("MARKET_DATA_BLOCKED");
    expect(err.message).toBe(BLOCKED_MESSAGE);
    expect(err.message).toBe(BLOCKED_MESSAGE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry other 4xx errors", async () => {
    const fetchFn = vi.fn(async () => json({ msg: "bad symbol" }, 400));
    const { rest } = makeRest(fetchFn as unknown as typeof fetch);
    await expect(rest.fetchKlines("BTCUSDT", "1h", 1)).rejects.toMatchObject({ code: "MARKET_DATA_REJECTED" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed rows", async () => {
    const { rest } = makeRest((async () => json([[1, "x"]])) as unknown as typeof fetch);
    await expect(rest.fetchKlines("BTCUSDT", "1h", 1)).rejects.toMatchObject({ code: "MARKET_DATA_INVALID_RESPONSE" });
  });
});

describe("BinanceRest.fetchTicker24h", () => {
  it("maps the 24h ticker", async () => {
    const fetchFn = vi.fn(async () => json({ lastPrice: "67000.10", priceChange: "-500.5", priceChangePercent: "-0.74" }));
    const { rest } = makeRest(fetchFn as unknown as typeof fetch);
    expect(await rest.fetchTicker24h("BTCUSDT")).toEqual({ symbol: "BTCUSDT", price: 67000.1, change24h: -500.5, changePercent24h: -0.74 });
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe("https://example.test/api/v3/ticker/24hr?symbol=BTCUSDT");
  });
});

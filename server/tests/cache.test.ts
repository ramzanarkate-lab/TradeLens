import { describe, expect, it, vi } from "vitest";
import { CandleCache } from "../src/market/cache.js";
import type { Candle } from "../src/types/index.js";

const candle = (time: number, closed = true): Candle => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, closed });

describe("CandleCache REST results", () => {
  it("returns the same data within the TTL and fetches again after it", async () => {
    let now = 1_000;
    const cache = new CandleCache({ ttlMs: 10_000, now: () => now });
    const fetcher = vi.fn(async () => ({ call: fetcher.mock.calls.length }));

    const first = await cache.getOrFetch("k", fetcher);
    now += 9_999;
    const second = await cache.getOrFetch("k", fetcher);
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 1; // exactly TTL elapsed
    const third = await cache.getOrFetch("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(third).not.toBe(first);
  });

  it("keeps separate entries per key and shares one in-flight fetch", async () => {
    const cache = new CandleCache({ now: () => 0 });
    const fetcher = vi.fn(async () => 1);
    await Promise.all([cache.getOrFetch("a", fetcher), cache.getOrFetch("a", fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.getOrFetch("b", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    const cache = new CandleCache({ now: () => 0 });
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("boom");
    await expect(cache.getOrFetch("k", fetcher)).resolves.toBe("ok");
  });
});

describe("CandleCache closed candle store", () => {
  it("keeps only closed candles, merged by time, capped at the newest 500", () => {
    const cache = new CandleCache();
    cache.upsertClosed("BTCUSDT", "1m", [candle(1, false), candle(2)]);
    expect(cache.getClosed("BTCUSDT", "1m").map((c) => c.time)).toEqual([2]);

    cache.upsertClosed("BTCUSDT", "1m", Array.from({ length: 600 }, (_, i) => candle(10 + i)));
    const stored = cache.getClosed("BTCUSDT", "1m");
    expect(stored).toHaveLength(500);
    expect(stored[0]!.time).toBe(110);
    expect(stored.at(-1)!.time).toBe(609);
    expect(cache.getClosed("BTCUSDT", "1m", 3).map((c) => c.time)).toEqual([607, 608, 609]);
    expect(cache.getClosed("ETHUSDT", "1m")).toEqual([]);
  });
});

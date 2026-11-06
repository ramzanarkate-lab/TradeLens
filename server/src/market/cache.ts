import type { Candle } from "../types/index.js";

export interface CandleCacheOptions {
  /** TTL for cached REST results (default 10s). */
  ttlMs?: number;
  /** Closed candles kept per symbol and interval (default 500). */
  maxClosed?: number;
  now?: () => number;
}

interface Entry {
  at: number;
  value: Promise<unknown>;
}

export class CandleCache {
  private readonly ttlMs: number;
  private readonly maxClosed: number;
  private readonly now: () => number;
  private readonly results = new Map<string, Entry>();
  private readonly series = new Map<string, Candle[]>();

  constructor(opts: CandleCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.maxClosed = opts.maxClosed ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** Returns the cached result for `key` while it is younger than the TTL, otherwise calls `fetcher`. Concurrent callers share one fetch; failures are not cached. */
  getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.results.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as Promise<T>;

    if (this.results.size > 200) this.purgeExpired(now);
    const value = fetcher();
    const entry: Entry = { at: now, value };
    this.results.set(key, entry);
    value.catch(() => {
      if (this.results.get(key) === entry) this.results.delete(key);
    });
    return value;
  }

  /** Stores the closed candles of a batch (open candles are skipped), merged by time, keeping the newest `maxClosed`. */
  upsertClosed(symbol: string, interval: string, candles: Candle[]): void {
    const closed = candles.filter((c) => c.closed);
    if (closed.length === 0) return;
    const key = `${symbol}:${interval}`;
    const byTime = new Map<number, Candle>((this.series.get(key) ?? []).map((c) => [c.time, c]));
    for (const c of closed) byTime.set(c.time, c);
    const merged = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-this.maxClosed);
    this.series.set(key, merged);
  }

  getClosed(symbol: string, interval: string, limit = this.maxClosed): Candle[] {
    return (this.series.get(`${symbol}:${interval}`) ?? []).slice(-limit);
  }

  private purgeExpired(now: number): void {
    for (const [key, entry] of this.results) {
      if (now - entry.at >= this.ttlMs) this.results.delete(key);
    }
  }
}

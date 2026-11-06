import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KlineInterval, Symbol } from "../config/symbols.js";
import { INTERVAL_MS } from "../market/providers/http.js";
import type { MarketProvider } from "../market/providers/types.js";
import type { Candle } from "../types/index.js";

/** Candles per request that every provider accepts (OKX history allows 100). */
const PAGE = 100;

/**
 * Closed candles of one interval from `startMs` up to `endMs`, oldest first, fetched page by page backwards from `endMs`.
 * Results are cached in `cacheDir/<symbol>-<interval>.json`; only the missing parts are fetched on later runs.
 */
export async function loadHistory(opts: {
  provider: MarketProvider;
  symbol: Symbol;
  interval: KlineInterval;
  startMs: number;
  endMs: number;
  cacheDir: string;
  log?: (message: string) => void;
}): Promise<Candle[]> {
  const { provider, symbol, interval, startMs, endMs, cacheDir } = opts;
  if (!provider.getCandlesBefore) throw new Error(`${provider.name} cannot page through history; use binance, bybit or okx`);
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${symbol}-${interval}.json`);
  const size = INTERVAL_MS[interval];
  const lastClosedStart = Math.floor(endMs / size) * size - size;

  let cached: Candle[] = [];
  if (existsSync(file)) {
    try {
      cached = JSON.parse(readFileSync(file, "utf8")) as Candle[];
    } catch {
      cached = [];
    }
  }

  const fetchRange = async (from: number, toExclusive: number): Promise<Candle[]> => {
    const got = new Map<number, Candle>();
    let end = toExclusive;
    for (let guard = 0; guard < 2000; guard++) {
      const page = await provider.getCandlesBefore!(symbol, interval, end, PAGE);
      if (page.length === 0) break;
      for (const c of page) if (c.time >= from) got.set(c.time, c);
      const oldest = page[0]!.time;
      if (oldest <= from || oldest >= end) break;
      end = oldest;
    }
    return [...got.values()];
  };

  const have = new Map(cached.map((c) => [c.time, c]));
  const first = cached[0]?.time;
  const last = cached[cached.length - 1]?.time;
  if (cached.length === 0) {
    opts.log?.(`${symbol} ${interval}: downloading`);
    for (const c of await fetchRange(startMs, lastClosedStart + size)) have.set(c.time, c);
  } else {
    if (first !== undefined && startMs < first) {
      opts.log?.(`${symbol} ${interval}: downloading older part`);
      for (const c of await fetchRange(startMs, first)) have.set(c.time, c);
    }
    if (last !== undefined && last < lastClosedStart) {
      opts.log?.(`${symbol} ${interval}: downloading newer part`);
      for (const c of await fetchRange(last + size, lastClosedStart + size)) have.set(c.time, c);
    }
  }

  const all = [...have.values()].filter((c) => c.closed).sort((a, b) => a.time - b.time);
  writeFileSync(`${file}.tmp`, JSON.stringify(all));
  renameSync(`${file}.tmp`, file);
  return all.filter((c) => c.time >= startMs && c.time <= lastClosedStart);
}

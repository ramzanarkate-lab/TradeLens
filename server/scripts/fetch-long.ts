/** Downloads ~5 years of 1H, 4H and 1D candles into data/history-long for research. npx tsx scripts/fetch-long.ts */
import { resolve } from "node:path";
import { loadHistory } from "../src/backtest/history.js";
import { BybitProvider } from "../src/market/providers/bybit.js";
import { OkxProvider } from "../src/market/providers/okx.js";
import type { MarketProvider } from "../src/market/providers/types.js";
import { DAY_MS } from "../src/signals/mtf.js";

const candidates: MarketProvider[] = [new OkxProvider(), new BybitProvider()];
let provider: MarketProvider | undefined;
for (const p of candidates) if ((await p.ping()).ok) { provider = p; break; }
if (!provider) throw new Error("no history provider reachable");
console.log("provider", provider.name);
const now = Date.now();
const cacheDir = resolve(import.meta.dirname, "../data/history-long");
for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const) {
  for (const interval of ["1h", "4h", "1d"] as const) {
    const c = await loadHistory({ provider, symbol, interval, startMs: now - 62 * 30.4375 * DAY_MS, endMs: now, cacheDir, log: console.log });
    console.log(symbol, interval, c.length, new Date(c[0]!.time).toISOString().slice(0, 10), "->", new Date(c[c.length - 1]!.time).toISOString().slice(0, 10));
  }
}

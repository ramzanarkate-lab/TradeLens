/**
 * Tests each market data provider once and prints a table. Exit code 0 if at least one works, otherwise 1.
 *   npm run check:market
 * Needs no keys and writes nothing.
 */
import "dotenv/config";
import { parseEnv } from "../src/config/env.js";
import { BinanceProvider } from "../src/market/providers/binance.js";
import { BybitProvider } from "../src/market/providers/bybit.js";
import { KrakenProvider } from "../src/market/providers/kraken.js";
import { OkxProvider } from "../src/market/providers/okx.js";

const env = parseEnv(process.env, { skipAuthCheck: true });
const providers = [new BybitProvider(), new OkxProvider(), new KrakenProvider(), new BinanceProvider({ baseUrl: env.MARKET_DATA_BASE_URL })];

const rows = await Promise.all(
  providers.map(async (p) => {
    const r = await p.ping();
    return { provider: p.name, status: r.status ?? "-", latency: `${r.latencyMs ?? 0} ms`, result: r.ok ? "OK" : r.detail };
  }),
);

const pad = (value: unknown, width: number) => String(value).padEnd(width);
console.log(`${pad("PROVIDER", 10)} ${pad("STATUS", 7)} ${pad("LATENCY", 9)} RESULT`);
for (const r of rows) console.log(`${pad(r.provider, 10)} ${pad(r.status, 7)} ${pad(r.latency, 9)} ${r.result}`);

const working = rows.filter((r) => r.result === "OK");
console.log(`\n${working.length} of ${rows.length} providers work. MARKET_PROVIDER=auto would pick: ${working[0]?.provider ?? "none"}`);
process.exit(working.length > 0 ? 0 : 1);

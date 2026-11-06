import { BLOCKED_MESSAGE, MarketDataError, marketError } from "../binanceRest.js";
import type { KlineInterval } from "../../config/symbols.js";
import { TIMEFRAME_MS } from "../aggregate.js";
import type { PingResult } from "./types.js";

export const INTERVAL_MS: Record<KlineInterval, number> = { "1m": 60_000, ...TIMEFRAME_MS };

/** GET and parse JSON. 403/451 -> MARKET_DATA_BLOCKED; other failures -> MARKET_DATA_UNAVAILABLE / _REJECTED. */
export async function getJson(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw marketError("MARKET_DATA_UNAVAILABLE", `Market data provider unreachable: ${reason}`);
  }
  if (res.status === 403 || res.status === 451) throw marketError("MARKET_DATA_BLOCKED", BLOCKED_MESSAGE, res.status);
  if (res.status === 429 || res.status >= 500) {
    throw marketError("MARKET_DATA_UNAVAILABLE", `Market data provider unavailable (HTTP ${res.status}).`, res.status);
  }
  if (!res.ok) throw marketError("MARKET_DATA_REJECTED", `Market data provider rejected the request (HTTP ${res.status}).`, res.status);
  try {
    return await res.json();
  } catch {
    throw invalid("response is not JSON");
  }
}

export function invalid(detail: string): MarketDataError {
  return new MarketDataError(502, "MARKET_DATA_INVALID_RESPONSE", `Unexpected market data response: ${detail}`);
}

/** Numbers from strings; throws if any value is not finite. */
export function num(value: unknown, field: string): number {
  const n = Number(value);
  if (value === null || value === "" || !Number.isFinite(n)) throw invalid(`${field} is not a number`);
  return n;
}

export const round = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals;

export async function pingWith(run: () => Promise<unknown>): Promise<PingResult> {
  const start = Date.now();
  const at = start;
  try {
    await run();
    return { ok: true, detail: "OK", status: 200, latencyMs: Date.now() - start, at };
  } catch (err) {
    const message = err instanceof MarketDataError ? `${err.code}` : err instanceof Error ? err.message : "error";
    const status = err instanceof MarketDataError ? err.upstreamStatus : undefined;
    return { ok: false, detail: message, status, latencyMs: Date.now() - start, at };
  }
}

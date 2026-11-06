import type { KlineInterval } from "../config/symbols.js";
import { AppError } from "../http/errors.js";
import type { Candle } from "../types/index.js";

export const BLOCKED_MESSAGE =
  "Market data is blocked from this network. Set MARKET_PROVIDER to another provider (bybit, okx or kraken), or leave it on auto.";

/** Failure talking to the market data provider. Maps to an HTTP error via the central handler. */
export class MarketDataError extends AppError {
  /** HTTP status the provider answered with, when there was one. */
  upstreamStatus?: number;
}

export function marketError(code: string, message: string, upstreamStatus?: number): MarketDataError {
  const err = new MarketDataError(502, code, message);
  if (upstreamStatus !== undefined) err.upstreamStatus = upstreamStatus;
  return err;
}

export interface Ticker24h {
  symbol: string;
  price: number;
  change24h: number;
  changePercent24h: number;
}

export interface BinanceRestOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Extra attempts after the first one (default 2). */
  retries?: number;
  backoffMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_LIMIT = 1000;

export class BinanceRest {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: BinanceRestOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  async fetchKlines(symbol: string, interval: KlineInterval, limit: number, endTimeMs?: number): Promise<Candle[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
    const rows = await this.request(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${capped}${endTimeMs !== undefined ? `&endTime=${endTimeMs}` : ""}`);
    if (!Array.isArray(rows)) throw invalid("klines response is not an array");
    const now = this.now();
    return rows.map((row) => {
      if (!Array.isArray(row) || row.length < 7) throw invalid("kline row has an unexpected shape");
      const candle: Candle = {
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        closed: Number(row[6]) < now,
      };
      if (Object.values(candle).some((v) => typeof v === "number" && !Number.isFinite(v))) {
        throw invalid("kline row contains a non-numeric value");
      }
      return candle;
    });
  }

  async fetchTicker24h(symbol: string): Promise<Ticker24h> {
    const body = (await this.request(`/api/v3/ticker/24hr?symbol=${symbol}`)) as Record<string, string> | null;
    const ticker: Ticker24h = {
      symbol,
      price: Number(body?.lastPrice),
      change24h: Number(body?.priceChange),
      changePercent24h: Number(body?.priceChangePercent),
    };
    if (!Number.isFinite(ticker.price)) throw invalid("ticker response has no valid lastPrice");
    return ticker;
  }

  /** GET with an 8s timeout; retries 5xx / network errors with exponential backoff. */
  private async request(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      try {
        const res = await this.fetchFn(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.status === 451 || res.status === 403) {
          throw marketError("MARKET_DATA_BLOCKED", BLOCKED_MESSAGE, res.status);
        }
        if (res.status >= 500) {
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          throw marketError("MARKET_DATA_REJECTED", `Market data provider rejected the request (HTTP ${res.status}). ${detail}`.trim(), res.status);
        }
        return await res.json();
      } catch (err) {
        if (err instanceof MarketDataError) throw err;
        lastError = err;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new MarketDataError(502, "MARKET_DATA_UNAVAILABLE", `Market data provider unavailable after ${this.retries + 1} attempts: ${reason}`);
  }
}

function invalid(detail: string): MarketDataError {
  return new MarketDataError(502, "MARKET_DATA_INVALID_RESPONSE", `Unexpected market data response: ${detail}`);
}

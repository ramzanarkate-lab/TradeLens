import type { KlineInterval, Symbol } from "../../config/symbols.js";
import type { Candle } from "../../types/index.js";

export const PROVIDER_NAMES = ["binance", "bybit", "okx", "kraken"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface Ticker {
  price: number;
  change24h: number;
  changePercent24h: number;
}

export interface PingResult {
  ok: boolean;
  /** HTTP status the provider answered with (200 when OK), if there was an answer. */
  status?: number;
  latencyMs?: number;
  /** When the test ran (epoch ms). */
  at?: number;
  /** "OK" or a short reason such as "HTTP 451" (never contains secrets). */
  detail: string;
}

/** A source of candles and prices. Every provider returns the same Candle shape: time in ms, numeric OHLCV, ascending order. */
export interface MarketProvider {
  readonly name: ProviderName;
  /** Newest `limit` candles, oldest first. The last one may still be forming (`closed: false`). */
  getCandles(symbol: Symbol, interval: KlineInterval, limit: number): Promise<Candle[]>;
  /**
   * History for backtests: up to `limit` closed candles that opened BEFORE `endMs`, oldest first.
   * Not every provider keeps deep history (Kraken only has the newest 720), so this is optional.
   */
  getCandlesBefore?(symbol: Symbol, interval: KlineInterval, endMs: number, limit: number): Promise<Candle[]>;
  getTicker(symbol: Symbol): Promise<Ticker>;
  /** Cheap reachability test. Never throws. */
  ping(): Promise<PingResult>;
}

export interface ProviderOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

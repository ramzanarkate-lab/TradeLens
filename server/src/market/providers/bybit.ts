import type { KlineInterval, Symbol } from "../../config/symbols.js";
import type { Candle } from "../../types/index.js";
import { getJson, INTERVAL_MS, invalid, num, pingWith, round } from "./http.js";
import { providerSymbol } from "./symbolMap.js";
import type { MarketProvider, PingResult, ProviderOptions, Ticker } from "./types.js";

export const BYBIT_DEFAULT_BASE_URL = "https://api.bybit.com";
const INTERVAL: Record<KlineInterval, string> = { "1m": "1", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

interface BybitEnvelope {
  retCode?: number;
  retMsg?: string;
  result?: { list?: unknown };
}

export class BybitProvider implements MarketProvider {
  readonly name = "bybit" as const;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ProviderOptions = {}) {
    this.base = (opts.baseUrl ?? BYBIT_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.now = opts.now ?? Date.now;
  }

  private async list(path: string): Promise<unknown[]> {
    const body = (await getJson(this.fetchFn, `${this.base}${path}`, this.timeoutMs)) as BybitEnvelope | null;
    if (!body || body.retCode !== 0 || !Array.isArray(body.result?.list)) throw invalid(`Bybit error ${body?.retCode ?? "?"}`);
    return body.result.list;
  }

  /** Rows are [startMs, open, high, low, close, volume, turnover], newest first. */
  async getCandles(symbol: Symbol, interval: KlineInterval, limit: number): Promise<Candle[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const rows = await this.list(
      `/v5/market/kline?category=spot&symbol=${providerSymbol("bybit", symbol)}&interval=${INTERVAL[interval]}&limit=${capped}`,
    );
    return this.toCandles(rows, interval);
  }

  private toCandles(rows: unknown[], interval: KlineInterval): Candle[] {
    const now = this.now();
    return rows
      .map((row) => {
        if (!Array.isArray(row) || row.length < 6) throw invalid("kline row has an unexpected shape");
        const time = num(row[0], "time");
        return {
          time,
          open: num(row[1], "open"),
          high: num(row[2], "high"),
          low: num(row[3], "low"),
          close: num(row[4], "close"),
          volume: num(row[5], "volume"),
          closed: time + INTERVAL_MS[interval] <= now,
        };
      })
      .reverse();
  }

  async getCandlesBefore(symbol: Symbol, interval: KlineInterval, endMs: number, limit: number): Promise<Candle[]> {
    const rows = await this.list(
      `/v5/market/kline?category=spot&symbol=${providerSymbol("bybit", symbol)}&interval=${INTERVAL[interval]}&limit=${Math.min(Math.max(Math.trunc(limit), 1), 1000)}&end=${endMs - 1}`,
    );
    return this.toCandles(rows, interval).filter((c) => c.closed && c.time < endMs);
  }

  async getTicker(symbol: Symbol): Promise<Ticker> {
    const rows = await this.list(`/v5/market/tickers?category=spot&symbol=${providerSymbol("bybit", symbol)}`);
    const t = rows[0] as Record<string, string> | undefined;
    if (!t) throw invalid("no ticker returned");
    const price = num(t.lastPrice, "lastPrice");
    const prev = num(t.prevPrice24h, "prevPrice24h");
    return { price, change24h: round(price - prev, 4), changePercent24h: round(num(t.price24hPcnt, "price24hPcnt") * 100, 3) };
  }

  ping(): Promise<PingResult> {
    return pingWith(() => this.getCandles("BTCUSDT", "1h", 1));
  }
}

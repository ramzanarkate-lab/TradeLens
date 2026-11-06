import type { KlineInterval, Symbol } from "../../config/symbols.js";
import type { Candle } from "../../types/index.js";
import { getJson, INTERVAL_MS, invalid, num, pingWith, round } from "./http.js";
import { providerSymbol } from "./symbolMap.js";
import type { MarketProvider, PingResult, ProviderOptions, Ticker } from "./types.js";

export const OKX_DEFAULT_BASE_URL = "https://www.okx.com";
const BAR: Record<KlineInterval, string> = { "1m": "1m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
const PAGE = 300; // OKX returns at most 300 candles per request

export class OkxProvider implements MarketProvider {
  readonly name = "okx" as const;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ProviderOptions = {}) {
    this.base = (opts.baseUrl ?? OKX_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.now = opts.now ?? Date.now;
  }

  private async data(path: string): Promise<unknown[]> {
    const body = (await getJson(this.fetchFn, `${this.base}${path}`, this.timeoutMs)) as { code?: string; data?: unknown } | null;
    if (!body || body.code !== "0" || !Array.isArray(body.data)) throw invalid(`OKX error ${body?.code ?? "?"}`);
    return body.data;
  }

  /** Rows are [ts, open, high, low, close, volume, volCcy, volCcyQuote, confirm], newest first. Pages back for more than 300. */
  async getCandles(symbol: Symbol, interval: KlineInterval, limit: number): Promise<Candle[]> {
    const wanted = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const inst = providerSymbol("okx", symbol);
    const rows: unknown[] = [];
    let after: string | undefined;
    while (rows.length < wanted) {
      const size = Math.min(PAGE, wanted - rows.length);
      const page = await this.data(`/api/v5/market/candles?instId=${inst}&bar=${BAR[interval]}&limit=${size}${after ? `&after=${after}` : ""}`);
      if (page.length === 0) break;
      rows.push(...page);
      const oldest = page[page.length - 1];
      after = Array.isArray(oldest) ? String(oldest[0]) : undefined;
      if (page.length < size || !after) break;
    }
    return this.toCandles(rows, interval);
  }

  private toCandles(rows: unknown[], interval: KlineInterval): Candle[] {
    const now = this.now();
    return rows
      .map((row) => {
        if (!Array.isArray(row) || row.length < 6) throw invalid("candle row has an unexpected shape");
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
    const size = Math.min(Math.max(Math.trunc(limit), 1), 100); // history-candles returns at most 100 per request
    const rows = await this.data(`/api/v5/market/history-candles?instId=${providerSymbol("okx", symbol)}&bar=${BAR[interval]}&limit=${size}&after=${endMs}`);
    return this.toCandles(rows, interval).filter((c) => c.closed && c.time < endMs);
  }

  async getTicker(symbol: Symbol): Promise<Ticker> {
    const rows = await this.data(`/api/v5/market/ticker?instId=${providerSymbol("okx", symbol)}`);
    const t = rows[0] as Record<string, string> | undefined;
    if (!t) throw invalid("no ticker returned");
    const price = num(t.last, "last");
    const open = num(t.open24h, "open24h");
    return { price, change24h: round(price - open, 4), changePercent24h: open === 0 ? 0 : round(((price - open) / open) * 100, 3) };
  }

  ping(): Promise<PingResult> {
    return pingWith(() => this.getCandles("BTCUSDT", "1h", 1));
  }
}

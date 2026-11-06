import type { KlineInterval, Symbol } from "../../config/symbols.js";
import type { Candle } from "../../types/index.js";
import { getJson, INTERVAL_MS, invalid, num, pingWith, round } from "./http.js";
import { providerSymbol } from "./symbolMap.js";
import type { MarketProvider, PingResult, ProviderOptions, Ticker } from "./types.js";

export const KRAKEN_DEFAULT_BASE_URL = "https://api.kraken.com";
const MINUTES: Record<KlineInterval, number> = { "1m": 1, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };

interface KrakenEnvelope {
  error?: unknown[];
  result?: Record<string, unknown>;
}

export class KrakenProvider implements MarketProvider {
  readonly name = "kraken" as const;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ProviderOptions = {}) {
    this.base = (opts.baseUrl ?? KRAKEN_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.now = opts.now ?? Date.now;
  }

  /** Kraken names the result key after its own pair name (e.g. XBTUSDT may come back as "XBTUSDT" or "XXBTZUSD"). */
  private async result(path: string): Promise<{ key: string; value: unknown }> {
    const body = (await getJson(this.fetchFn, `${this.base}${path}`, this.timeoutMs)) as KrakenEnvelope | null;
    if (!body || !Array.isArray(body.error) || body.error.length > 0 || !body.result) {
      throw invalid(`Kraken error ${Array.isArray(body?.error) ? String(body.error[0] ?? "?") : "?"}`);
    }
    const key = Object.keys(body.result).find((k) => k !== "last");
    if (!key) throw invalid("no data for the pair");
    return { key, value: body.result[key] };
  }

  /** Rows are [timeSeconds, open, high, low, close, vwap, volume, count], oldest first. The last row is the forming candle. */
  async getCandles(symbol: Symbol, interval: KlineInterval, limit: number): Promise<Candle[]> {
    const { value } = await this.result(`/0/public/OHLC?pair=${providerSymbol("kraken", symbol)}&interval=${MINUTES[interval]}`);
    if (!Array.isArray(value)) throw invalid("OHLC data is not a list");
    const now = this.now();
    const candles = value.map((row) => {
      if (!Array.isArray(row) || row.length < 7) throw invalid("OHLC row has an unexpected shape");
      const time = num(row[0], "time") * 1000;
      return {
        time,
        open: num(row[1], "open"),
        high: num(row[2], "high"),
        low: num(row[3], "low"),
        close: num(row[4], "close"),
        volume: num(row[6], "volume"),
        closed: time + INTERVAL_MS[interval] <= now,
      };
    });
    return candles.slice(-Math.min(Math.max(Math.trunc(limit), 1), 1000));
  }

  /** Kraken reports the change since today's open (UTC), not a rolling 24 hours. */
  async getTicker(symbol: Symbol): Promise<Ticker> {
    const { value } = await this.result(`/0/public/Ticker?pair=${providerSymbol("kraken", symbol)}`);
    const t = value as { c?: unknown[]; o?: unknown } | null;
    const price = num(t?.c?.[0], "last");
    const open = num(t?.o, "open");
    return { price, change24h: round(price - open, 4), changePercent24h: open === 0 ? 0 : round(((price - open) / open) * 100, 3) };
  }

  ping(): Promise<PingResult> {
    return pingWith(() => this.getCandles("SOLUSDT", "1h", 1));
  }
}

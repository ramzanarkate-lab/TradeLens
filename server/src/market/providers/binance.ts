import type { KlineInterval, Symbol } from "../../config/symbols.js";
import type { Candle } from "../../types/index.js";
import { BinanceRest } from "../binanceRest.js";
import { pingWith } from "./http.js";
import { providerSymbol } from "./symbolMap.js";
import type { MarketProvider, PingResult, ProviderOptions, Ticker } from "./types.js";

/** The one place the Binance REST address lives. MARKET_DATA_BASE_URL can point it at a mirror. */
export const BINANCE_DEFAULT_BASE_URL = "https://api.binance.com";

export class BinanceProvider implements MarketProvider {
  readonly name = "binance" as const;
  private readonly rest: BinanceRest;

  constructor(opts: ProviderOptions = {}) {
    this.rest = new BinanceRest({
      baseUrl: opts.baseUrl ?? BINANCE_DEFAULT_BASE_URL,
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs,
      now: opts.now,
      retries: 0, // the registry counts failures and switches providers, so no hidden retries here
    });
  }

  getCandles(symbol: Symbol, interval: KlineInterval, limit: number): Promise<Candle[]> {
    return this.rest.fetchKlines(providerSymbol("binance", symbol), interval, limit);
  }

  async getCandlesBefore(symbol: Symbol, interval: KlineInterval, endMs: number, limit: number): Promise<Candle[]> {
    const rows = await this.rest.fetchKlines(providerSymbol("binance", symbol), interval, limit, endMs - 1);
    return rows.filter((c) => c.closed && c.time < endMs);
  }

  async getTicker(symbol: Symbol): Promise<Ticker> {
    const t = await this.rest.fetchTicker24h(providerSymbol("binance", symbol));
    return { price: t.price, change24h: t.change24h, changePercent24h: t.changePercent24h };
  }

  ping(): Promise<PingResult> {
    return pingWith(() => this.rest.fetchKlines("BTCUSDT", "1h", 1));
  }
}

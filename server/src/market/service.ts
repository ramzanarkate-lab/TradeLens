import type { KlineInterval, Symbol, Timeframe } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import type { Candle } from "../types/index.js";
import { candleTopic } from "../ws/hub.js";
import { computePivots, type PivotsResult } from "../analysis/pivots.js";
import { aggregateCandles } from "./aggregate.js";
import { MarketDataError, type Ticker24h } from "./binanceRest.js";
import type { FeedStatus, MarketFeed } from "./binanceWs.js";
import type { CandleCache } from "./cache.js";

export interface CandlesResult {
  symbol: Symbol;
  interval: Timeframe;
  /** The provider name (e.g. "binance", "okx"); "aggregated" = rebuilt from the live 1m feed. */
  source: string;
  candles: Candle[];
}

export interface PriceResult {
  symbol: Symbol;
  price: number;
  change24h: number | null;
  changePercent24h: number | null;
  source: string;
}

export interface Publisher {
  broadcast(topic: string, data: unknown): number;
}

/** What the market service needs from a provider (the provider registry, or the offline demo data). */
export interface MarketRest {
  fetchKlines(symbol: Symbol, interval: KlineInterval, limit: number): Promise<Candle[]>;
  fetchTicker24h(symbol: Symbol): Promise<Ticker24h>;
  /** Name of the provider currently in use. */
  readonly activeName?: string;
}

export interface MarketServiceDeps {
  rest: MarketRest;
  cache: CandleCache;
  stream?: Pick<MarketFeed, "getLatest" | "getStatus" | "on">;
  hub?: Publisher;
  logger: Logger;
}

export class MarketService {
  constructor(private readonly deps: MarketServiceDeps) {}

  /** Forwards live candles and status changes to the WebSocket hub, and keeps closed 1m candles for aggregation. */
  start(): void {
    const { stream, hub, cache } = this.deps;
    if (!stream) return;
    stream.on("candle", (symbol: Symbol, candle: Candle, ticker?: { price: number; change24h: number; changePercent24h: number }) => {
      if (candle.closed) cache.upsertClosed(symbol, "1m", [candle]);
      hub?.broadcast(candleTopic(symbol), { symbol, interval: "1m", candle, ...(ticker ? { ticker } : {}) });
    });
    stream.on("status", (status: FeedStatus) => {
      this.deps.logger.info({ status }, "market feed status");
      hub?.broadcast("status", { feed: status });
    });
  }

  feedStatus(): FeedStatus | "Disabled" {
    return this.deps.stream?.getStatus() ?? "Disabled";
  }

  async getCandles(symbol: Symbol, interval: Timeframe, limit: number): Promise<CandlesResult> {
    const { rest, cache } = this.deps;
    try {
      const candles = await cache.getOrFetch(`klines:${symbol}:${interval}:${limit}`, async () => {
        const fetched = await rest.fetchKlines(symbol, interval, limit);
        cache.upsertClosed(symbol, interval, fetched);
        return fetched;
      });
      return { symbol, interval, source: rest.activeName ?? "binance", candles };
    } catch (err) {
      if (!(err instanceof MarketDataError)) throw err;
      const fallback = this.aggregateFallback(symbol, interval, limit);
      if (fallback.length === 0) throw err;
      this.deps.logger.warn({ symbol, interval, reason: err.code }, "REST unavailable, serving candles aggregated from 1m feed");
      return { symbol, interval, source: "aggregated", candles: fallback };
    }
  }

  /** Candles straight from the provider, bypassing the 10s result cache (used right after a candle closes). */
  async getFreshCandles(symbol: Symbol, interval: Timeframe, limit: number): Promise<Candle[]> {
    const fetched = await this.deps.rest.fetchKlines(symbol, interval, limit);
    this.deps.cache.upsertClosed(symbol, interval, fetched);
    return fetched;
  }

  async getPrice(symbol: Symbol): Promise<PriceResult> {
    const { rest, cache, stream } = this.deps;
    try {
      const t: Ticker24h = await cache.getOrFetch(`ticker:${symbol}`, () => rest.fetchTicker24h(symbol));
      return { symbol, price: t.price, change24h: t.change24h, changePercent24h: t.changePercent24h, source: rest.activeName ?? "binance" };
    } catch (err) {
      if (!(err instanceof MarketDataError)) throw err;
      const latest = stream?.getLatest(symbol);
      if (!latest) throw err;
      return { symbol, price: latest.close, change24h: null, changePercent24h: null, source: "stream" };
    }
  }

  /** Daily classic pivots from the previous completed 1d candle. */
  async getPivots(symbol: Symbol): Promise<PivotsResult> {
    const { candles } = await this.getCandles(symbol, "1d", 10);
    const pivots = computePivots(symbol, candles);
    if (!pivots) {
      throw new MarketDataError(502, "NO_COMPLETED_DAILY_CANDLE", "No completed daily candle is available to calculate pivots.");
    }
    return pivots;
  }

  private aggregateFallback(symbol: Symbol, interval: Timeframe, limit: number): Candle[] {
    const { cache, stream } = this.deps;
    const minutes = cache.getClosed(symbol, "1m");
    const forming = stream?.getLatest(symbol);
    if (forming && !forming.closed) minutes.push(forming);
    return aggregateCandles(minutes, interval).slice(-limit);
  }
}

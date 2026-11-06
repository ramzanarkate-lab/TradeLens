import { readFileSync } from "node:fs";
import { TIMEFRAME_MS } from "../market/aggregate.js";
import { MarketDataError, type Ticker24h } from "../market/binanceRest.js";
import { isSymbol, type KlineInterval, type Timeframe } from "../config/symbols.js";
import type { Candle } from "../types/index.js";
import type { DemoFile } from "./seedData.js";

const DAY = TIMEFRAME_MS["1d"];

/**
 * Offline stand-in for the Binance REST client (DEMO_MODE=true). It reads the files written by `npm run seed`
 * and never touches the network. Candle times are shifted forward by whole days, so the newest candle is always recent
 * while every timeframe stays aligned.
 */
export class DemoRest {
  readonly activeName = "demo";
  private readonly data: DemoFile;
  private readonly shift: number;

  constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      this.data = JSON.parse(readFileSync(file, "utf8")) as DemoFile;
    } catch {
      throw new Error(`Demo data not found at ${file}. Run "npm run seed" first.`);
    }
    this.shift = Math.floor((this.now() - this.data.generatedAt) / DAY) * DAY;
  }

  fetchKlines(symbol: string, interval: KlineInterval, limit: number): Promise<Candle[]> {
    if (!isSymbol(symbol)) return Promise.reject(new MarketDataError(502, "MARKET_DATA_REJECTED", "Unknown symbol"));
    // The 1m feed does not exist in demo mode, so serve the 15m series for it.
    const tf: Timeframe = interval === "1m" ? "15m" : interval;
    const series = this.data.candles[symbol][tf];
    const now = this.now();
    const size = TIMEFRAME_MS[tf];
    const out = series.slice(-Math.min(Math.max(Math.trunc(limit), 1), 1000)).map((c) => ({
      ...c,
      time: c.time + this.shift,
      closed: c.time + this.shift + size <= now,
    }));
    return Promise.resolve(out);
  }

  fetchTicker24h(symbol: string): Promise<Ticker24h> {
    if (!isSymbol(symbol)) return Promise.reject(new MarketDataError(502, "MARKET_DATA_REJECTED", "Unknown symbol"));
    const series = this.data.candles[symbol]["15m"];
    const last = series[series.length - 1]!;
    const dayAgo = series[Math.max(series.length - 97, 0)]!;
    const change = last.close - dayAgo.close;
    return Promise.resolve({
      symbol,
      price: last.close,
      change24h: Math.round(change * 10_000) / 10_000,
      changePercent24h: Math.round((change / dayAgo.close) * 10_000) / 100,
    });
  }
}

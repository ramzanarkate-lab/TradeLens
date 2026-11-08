import type { Logger } from "../logging/logger.js";
import type { MarketService } from "../market/service.js";
import { ema } from "../signals/indicators.js";
import { lastBacktestTrade, type BacktestTradeSummary } from "../signals/backtestStore.js";
import type { SignalStore } from "../signals/store.js";
import type { SettingsStore } from "../settings/store.js";
import type { Candle, PivotLevels, Signal } from "../types/index.js";
import type { Symbol, Timeframe } from "../config/symbols.js";

export type Trend = "Bullish" | "Bearish" | "Neutral";

export interface PivotRef {
  /** "S3" | "S2" | "S1" | "P" | "R1" | "R2" | "R3" */
  name: keyof PivotLevels;
  value: number;
}

export interface DashboardSymbol {
  symbol: Symbol;
  price: number | null;
  change24h: number | null;
  changePercent24h: number | null;
  trend: Trend;
  /** Nearest pivot level above the price (support/resistance reference). */
  pivotAbove: PivotRef | null;
  /** Nearest pivot level at or below the price. */
  pivotBelow: PivotRef | null;
  lastSignal: Signal | null;
  /** What the engine decided at its latest look at this symbol, so "no signal" is explained. */
  lastCheck: { at: number; candleTime: number; signal: boolean; reason: string | null } | null;
  /** The newest trade of the saved backtest (a past chart, not a live signal). Shown when there is no live signal yet. */
  lastBacktest: BacktestTradeSummary | null;
  /** Closes of the last 24 closed 1h candles, oldest first. */
  sparkline: number[];
}

export interface DashboardResponse {
  generatedAt: number;
  symbols: DashboardSymbol[];
  signals: {
    /** Signals created since 00:00 UTC today. */
    today: { total: number; buy: number; sell: number };
    /** The 5 newest signals across all symbols, newest first. */
    recent: Signal[];
  };
}

export interface DashboardDeps {
  market: Pick<MarketService, "getPrice" | "getCandles" | "getPivots">;
  settings: Pick<SettingsStore, "get">;
  signals: Pick<SignalStore, "list">;
  /** Folder with backtest reports, for the last-backtest fallback. */
  backtestDir?: string;
  /** The signal service's latest check per symbol. */
  lastChecks?: () => Record<string, { at: number; candleTime: number; signal: boolean; reason: string | null }>;
  logger?: Logger;
  now?: () => number;
  /** How long a built response is reused (default 5s). */
  ttlMs?: number;
}

const SPARKLINE_POINTS = 24;
const CANDLES_FOR_TREND = 200;
const DAY_MS = 86_400_000;
/** EMAs closer than this (relative) count as equal, so floating-point noise cannot flip the trend. */
const NEUTRAL_BAND = 1e-6;

const LEVEL_ORDER: Array<keyof PivotLevels> = ["S3", "S2", "S1", "P", "R1", "R2", "R3"];

export function trendFrom(closes: number[], fastPeriod: number, slowPeriod: number): Trend {
  const fast = ema(closes, fastPeriod).at(-1);
  const slow = ema(closes, slowPeriod).at(-1);
  if (fast === undefined || slow === undefined || Number.isNaN(fast) || Number.isNaN(slow)) return "Neutral";
  if (Math.abs(fast - slow) <= Math.abs(slow) * NEUTRAL_BAND) return "Neutral";
  return fast > slow ? "Bullish" : "Bearish";
}

/** Nearest pivot above the price (strictly greater) and nearest at or below it. */
export function nearestPivots(price: number, pivots: PivotLevels): { above: PivotRef | null; below: PivotRef | null } {
  let above: PivotRef | null = null;
  let below: PivotRef | null = null;
  for (const name of LEVEL_ORDER) {
    const value = pivots[name];
    if (value > price && (above === null || value < above.value)) above = { name, value };
    if (value <= price && (below === null || value > below.value)) below = { name, value };
  }
  return { above, below };
}

/** Everything the dashboard screen needs, in one response, cached briefly. */
export class DashboardService {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached?: { at: number; value: Promise<DashboardResponse> };

  constructor(private readonly deps: DashboardDeps) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? 5_000;
  }

  get(): Promise<DashboardResponse> {
    const now = this.now();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.value;
    const entry = { at: now, value: this.build(now) };
    this.cached = entry;
    entry.value.catch(() => {
      if (this.cached === entry) this.cached = undefined; // never cache a failure
    });
    return entry.value;
  }

  private async build(now: number): Promise<DashboardResponse> {
    const settings = this.deps.settings.get();
    const symbols = await Promise.all(settings.symbols.enabled.map((s) => this.buildSymbol(s, settings.signals)));

    // If nothing at all could be loaded (e.g. market data blocked), surface the real error instead of empty cards.
    const failure = symbols.find((s) => s.failure)?.failure;
    if (failure && symbols.every((s) => s.entry.price === null && s.entry.sparkline.length === 0)) throw failure;

    const all = this.deps.signals.list({ limit: 1000 });
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    const today = all.filter((s) => s.createdAt >= dayStart);
    return {
      generatedAt: now,
      symbols: symbols.map((s) => s.entry),
      signals: {
        today: {
          total: today.length,
          buy: today.filter((s) => s.side === "BUY").length,
          sell: today.filter((s) => s.side === "SELL").length,
        },
        recent: all.slice(0, 5),
      },
    };
  }

  private async buildSymbol(
    symbol: Symbol,
    strategy: { emaFast: number; emaSlow: number; timeframe: Timeframe },
  ): Promise<{ entry: DashboardSymbol; failure?: unknown }> {
    const { market, signals } = this.deps;
    const [priceR, hourlyR, pivotsR, trendR] = await Promise.allSettled([
      market.getPrice(symbol),
      market.getCandles(symbol, "1h", CANDLES_FOR_TREND),
      market.getPivots(symbol),
      // The trend uses the strategy's timeframe; when that is 1h the hourly candles are reused.
      strategy.timeframe === "1h" ? Promise.resolve(null) : market.getCandles(symbol, strategy.timeframe, CANDLES_FOR_TREND),
    ]);

    const hourly: Candle[] = hourlyR.status === "fulfilled" ? hourlyR.value.candles : [];
    const trendCandles: Candle[] =
      strategy.timeframe === "1h" ? hourly : trendR.status === "fulfilled" && trendR.value ? trendR.value.candles : [];
    const closedCloses = (list: Candle[]) => list.filter((c) => c.closed).map((c) => c.close);

    // Price: the ticker, or the latest candle close if the ticker is unavailable.
    const price = priceR.status === "fulfilled" ? priceR.value.price : (hourly.at(-1)?.close ?? null);
    const pivots = pivotsR.status === "fulfilled" ? pivotsR.value : null;
    const near = price !== null && pivots ? nearestPivots(price, pivots) : { above: null, below: null };

    const failure = [priceR, hourlyR, pivotsR].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failure) this.deps.logger?.warn({ symbol, reason: String(failure.reason) }, "dashboard: partial data");

    return {
      entry: {
        symbol,
        price,
        change24h: priceR.status === "fulfilled" ? priceR.value.change24h : null,
        changePercent24h: priceR.status === "fulfilled" ? priceR.value.changePercent24h : null,
        trend: trendFrom(closedCloses(trendCandles), strategy.emaFast, strategy.emaSlow),
        pivotAbove: near.above,
        pivotBelow: near.below,
        lastSignal: signals.list({ symbol, limit: 1 })[0] ?? null,
        lastCheck: this.deps.lastChecks?.()[symbol] ?? null,
        lastBacktest: this.deps.backtestDir ? lastBacktestTrade(this.deps.backtestDir, symbol) : null,
        sparkline: closedCloses(hourly).slice(-SPARKLINE_POINTS),
      },
      failure: failure?.reason,
    };
  }
}

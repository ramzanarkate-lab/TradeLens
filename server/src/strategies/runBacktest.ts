import type { Candle } from "../types/index.js";
import { buildRow, type StrategyBacktestRow } from "./backtestStore.js";
import { simulateDca } from "./dca.js";
import { simulateStandard, type SimulatedTrade } from "./engine.js";
import { simulateGrid } from "./grid.js";
import { STRATEGIES } from "./library.js";
import { TIMEFRAME_MS, type Strategy, type StrategyTimeframe } from "./types.js";

const MONTH_MS = 30.4375 * 24 * 3_600_000;

export interface BacktestConfig {
  symbols: readonly string[];
  /** How many months of candles each timeframe is tested on. */
  months: Record<StrategyTimeframe, number>;
  loadCandles(symbol: string, timeframe: StrategyTimeframe): Candle[];
  /** Fraction of the period that is in-sample (the rest is out-of-sample). Default 0.7. */
  inSampleShare?: number;
  strategies?: readonly Strategy[];
}

/** The period one strategy is tested on, and where in-sample ends. */
export function periodFor(candles: Candle[], tf: StrategyTimeframe, months: number, warmup: number, inSampleShare = 0.7) {
  const tfMs = TIMEFRAME_MS[tf];
  const end = candles[candles.length - 1]!.time + tfMs;
  const wanted = candles.findIndex((c) => c.time >= end - months * MONTH_MS);
  const startIndex = Math.max(warmup, wanted < 0 ? 0 : wanted);
  const from = candles[startIndex]!.time;
  const splitAt = Math.floor(from + (end - from) * inSampleShare);
  return { startIndex, from, to: end, splitAt };
}

/**
 * Backtests every strategy on every symbol, on its own timeframe, with the fees and slippage of the common rules. The first
 * 70% of the period is in-sample and the last 30% out-of-sample. Nothing is tuned: the rules are fixed before this runs.
 * DcaAccumulator follows the trades of the 1h strategies on the same candles.
 */
export function runAllBacktests(cfg: BacktestConfig): StrategyBacktestRow[] {
  const strategies = cfg.strategies ?? STRATEGIES;
  const rows: StrategyBacktestRow[] = [];
  for (const symbol of cfg.symbols) {
    // the parents of DcaAccumulator: standard strategies on 1h candles
    const parentTrades: SimulatedTrade[] = [];
    const candles1h = strategies.some((s) => s.kind === "dca") ? cfg.loadCandles(symbol, "1h") : [];
    if (candles1h.length) {
      const p = (s: Strategy) => periodFor(candles1h, "1h", cfg.months["1h"], s.warmup, cfg.inSampleShare);
      for (const s of strategies.filter((x) => x.kind === "standard" && x.timeframe === "1h")) parentTrades.push(...simulateStandard(s, candles1h, { symbol }, p(s).startIndex));
    }

    for (const strategy of strategies) {
      const candles = strategy.kind === "dca" ? candles1h : cfg.loadCandles(symbol, strategy.timeframe);
      if (candles.length <= strategy.warmup + 1) continue;
      const period = periodFor(candles, strategy.timeframe, cfg.months[strategy.timeframe], strategy.warmup, cfg.inSampleShare);
      const trades =
        strategy.kind === "grid"
          ? simulateGrid(strategy.id, candles, period.startIndex)
          : strategy.kind === "dca"
            ? simulateDca(strategy.id, candles, parentTrades.filter((t) => t.createdAt >= candles[period.startIndex]!.time))
            : simulateStandard(strategy, candles, { symbol }, period.startIndex);
      rows.push(buildRow({ strategyId: strategy.id, symbol, timeframe: strategy.timeframe, from: period.from, to: period.to, splitAt: period.splitAt, trades }));
    }
  }
  return rows;
}

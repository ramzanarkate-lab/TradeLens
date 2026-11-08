import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import { PASS_THRESHOLDS, type StrategyBacktestStore } from "../strategies/backtestStore.js";
import { STRATEGIES } from "../strategies/library.js";
import type { StrategySignalStore } from "../strategies/signalStore.js";
import { validate } from "./validate.js";

export interface StrategyRouterDeps {
  backtests: StrategyBacktestStore;
  signals: StrategySignalStore;
}

const listQuery = z.object({
  strategyId: z.string().max(60).optional(),
  symbol: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The admin view of the strategy library. Read only: nothing here can change a strategy's status. A status changes only when a
 * new backtest run writes data/strategy-backtests.json.
 */
export function createStrategyRouter({ backtests, signals }: StrategyRouterDeps): Router {
  const router = Router();

  // The backtest table: strategy, symbol, timeframe, in-sample and out-of-sample expectancy, out-of-sample trades, drawdown, status.
  router.get("/admin/strategies", requireAdmin, (_req, res) => {
    const file = backtests.read();
    res.json({
      generatedAt: file?.generatedAt ?? null,
      months: file?.months ?? null,
      note: file?.note ?? "No backtest has been run yet, so no strategy has passed: every signal is research only.",
      thresholds: file?.thresholds ?? PASS_THRESHOLDS,
      rows: (file?.rows ?? []).map((r) => ({
        strategyId: r.strategyId,
        symbol: r.symbol,
        timeframe: r.timeframe,
        inSampleExpectancyR: r.inSample.expectancyR,
        outOfSampleExpectancyR: r.outOfSample.expectancyR,
        outOfSampleTrades: r.outOfSample.trades,
        outOfSampleProfitFactor: r.outOfSample.profitFactor,
        maxDrawdownR: r.outOfSample.maxDrawdownR,
        maxDrawdownPercent: r.outOfSample.maxDrawdownPercent,
        status: r.status,
      })),
      strategies: STRATEGIES.map((s) => ({ id: s.id, number: s.number, timeframe: s.timeframe })),
    });
  });

  // Every signal of every strategy, passed or not, wins and losses alike, with its outcome.
  router.get("/admin/strategy-signals", requireAdmin, validate({ query: listQuery }), (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const { signals: page, total } = signals.query(q);
    res.json({
      total,
      signals: page.map((s) => ({
        id: s.id,
        strategyId: s.strategyId,
        symbol: s.symbol,
        timeframe: s.timeframe,
        direction: s.direction,
        entry: s.entry,
        stopLoss: s.stopLoss,
        tp1: s.tp1 ?? null,
        tp2: s.tp2 ?? null,
        tp3: s.tp3 ?? null,
        createdAt: s.createdAt,
        validated: s.validated,
        researchOnly: s.researchOnly,
        status: s.status,
        outcome: s.outcome ?? null,
      })),
    });
  });

  return router;
}

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_COSTS, judge, type CostModel, type PartMetrics } from "../backtest/backtest.js";
import { DEFAULT_SIGNAL_SETTINGS } from "../config/signalDefaults.js";
import { RISK_PER_TRADE, type SimulatedTrade } from "./engine.js";

export type StrategyStatus = "PASSED" | "NOT PASSED" | "INSUFFICIENT SAMPLE";

/** The same bar the app's own backtest gate uses (out-of-sample part only). */
export const PASS_THRESHOLDS = {
  minProfitFactor: DEFAULT_SIGNAL_SETTINGS.backtestMinProfitFactor,
  minTrades: DEFAULT_SIGNAL_SETTINGS.backtestMinTrades,
  maxDrawdownR: DEFAULT_SIGNAL_SETTINGS.backtestMaxDrawdownR,
};

export interface PartStats {
  trades: number;
  /** Average net result per trade in R (after fees and slippage). */
  expectancyR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  /** Share of trades with a positive net result, in percent. */
  winRate: number | null;
  /** Equity change in percent when every trade risks 1% of the virtual equity (compounded). */
  equityReturnPercent: number;
  /** Largest fall of that equity from a peak, in percent. */
  maxDrawdownPercent: number;
}

export interface StrategyBacktestRow {
  strategyId: string;
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
  /** The first 70% of the period is in-sample, the rest out-of-sample. */
  splitAt: string;
  inSample: PartStats;
  outOfSample: PartStats;
  status: StrategyStatus;
  checks: Array<{ name: string; need: string; got: string; ok: boolean }>;
}

export interface StrategyBacktestFile {
  generatedAt: string;
  months: number;
  costs: CostModel;
  thresholds: typeof PASS_THRESHOLDS;
  note: string;
  rows: StrategyBacktestRow[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Numbers for a group of trades, in the order they closed. */
export function partStats(trades: SimulatedTrade[]): PartStats {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const rs = ordered.map((t) => t.netR);
  const gains = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  let equity = 0;
  let peak = 0;
  let dd = 0;
  let virtual = 1; // virtual equity, every trade risks 1% of it
  let virtualPeak = 1;
  let virtualDd = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    virtual *= 1 + RISK_PER_TRADE * r;
    virtualPeak = Math.max(virtualPeak, virtual);
    virtualDd = Math.max(virtualDd, (virtualPeak - virtual) / virtualPeak);
  }
  const n = rs.length;
  return {
    trades: n,
    expectancyR: n ? round(rs.reduce((a, b) => a + b, 0) / n, 3) : null,
    profitFactor: losses > 0 ? round(gains / losses) : null,
    maxDrawdownR: round(dd),
    winRate: n ? round((rs.filter((r) => r > 0).length / n) * 100, 1) : null,
    equityReturnPercent: round((virtual - 1) * 100),
    maxDrawdownPercent: round(virtualDd * 100),
  };
}

/** PASSED needs enough out-of-sample trades, then the profit factor and drawdown bars. Fewer trades is INSUFFICIENT SAMPLE, never a pass. */
export function statusFor(out: PartStats, t = PASS_THRESHOLDS): { status: StrategyStatus; checks: StrategyBacktestRow["checks"] } {
  const verdict = judge({ ...out, winRate: out.winRate, profitableRate: null, avgR: out.expectancyR, tradesPerMonth: 0, longestLosingStreak: 0 } as PartMetrics, t);
  const positive = (out.expectancyR ?? 0) > 0;
  const checks = [...verdict.checks, { name: "expectancy (R)", need: "> 0", got: String(out.expectancyR), ok: positive }];
  if (out.trades < t.minTrades) return { status: "INSUFFICIENT SAMPLE", checks };
  return { status: checks.every((c) => c.ok) ? "PASSED" : "NOT PASSED", checks };
}

export const BACKTEST_NOTE =
  "Each strategy was replayed over the same candles with fees 0.1% per side and slippage 0.05%. The first 70% of the period is in-sample and the last 30% out-of-sample. No parameter was changed after looking at the out-of-sample result.";

export function buildRow(args: { strategyId: string; symbol: string; timeframe: string; from: number; to: number; splitAt: number; trades: SimulatedTrade[] }): StrategyBacktestRow {
  const inS = args.trades.filter((t) => t.createdAt < args.splitAt);
  const outS = args.trades.filter((t) => t.createdAt >= args.splitAt);
  const outOfSample = partStats(outS);
  const { status, checks } = statusFor(outOfSample);
  return {
    strategyId: args.strategyId,
    symbol: args.symbol,
    timeframe: args.timeframe,
    from: new Date(args.from).toISOString(),
    to: new Date(args.to).toISOString(),
    splitAt: new Date(args.splitAt).toISOString(),
    inSample: partStats(inS),
    outOfSample,
    status,
    checks,
  };
}

export function newBacktestFile(months: number, rows: StrategyBacktestRow[], now = Date.now()): StrategyBacktestFile {
  return { generatedAt: new Date(now).toISOString(), months, costs: DEFAULT_COSTS, thresholds: PASS_THRESHOLDS, note: BACKTEST_NOTE, rows };
}

export function saveBacktestFile(file: string, data: StrategyBacktestFile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${file}.tmp`, file);
}

/**
 * Reads the saved backtest results and answers "did this strategy pass for this symbol and timeframe?".
 * Nothing in the app can change a status: only a new backtest run writes this file. No result means not passed.
 */
export class StrategyBacktestStore {
  private cache?: { mtime: number; data: StrategyBacktestFile | null };

  constructor(private readonly file: string) {}

  read(): StrategyBacktestFile | null {
    try {
      if (!existsSync(this.file)) return null;
      const mtime = statSync(this.file).mtimeMs;
      if (this.cache?.mtime === mtime) return this.cache.data;
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StrategyBacktestFile;
      this.cache = { mtime, data: Array.isArray(parsed?.rows) ? parsed : null };
      return this.cache.data;
    } catch {
      return null;
    }
  }

  rows(): StrategyBacktestRow[] {
    return this.read()?.rows ?? [];
  }

  status(strategyId: string, symbol: string, timeframe: string): StrategyStatus | null {
    return this.rows().find((r) => r.strategyId === strategyId && r.symbol === symbol && r.timeframe === timeframe)?.status ?? null;
  }
}

/** The validation check used for routing. Only a saved PASSED result is true. */
export function strategyPassed(store: Pick<StrategyBacktestStore, "status">, strategyId: string, symbol: string, timeframe: string): boolean {
  return store.status(strategyId, symbol, timeframe) === "PASSED";
}

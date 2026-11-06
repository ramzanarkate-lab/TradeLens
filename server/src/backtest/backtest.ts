import type { Symbol } from "../config/symbols.js";
import type { Signal } from "../types/index.js";
import { evaluateAt, prepareContext, type EngineConfig } from "../signals/engine.v2.js";
import { advance, isActive } from "../signals/lifecycle.js";
import { HOUR_MS, type MtfSeries } from "../signals/mtf.js";
import { reachedTp1 } from "../signals/stats.js";

export interface CostModel {
  /** Fee per side as a fraction of the price (0.001 = 0.1%). */
  feePerSide: number;
  /** Slippage per fill as a fraction of the price (0.0005 = 0.05%), always against the trade. */
  slippage: number;
}

export const DEFAULT_COSTS: CostModel = { feePerSide: 0.001, slippage: 0.0005 };

export interface Trade {
  signal: Signal;
  exitStatus: Signal["status"];
  exitPrice: number;
  /** R-multiple before fees and slippage (what the app shows). */
  grossR: number;
  /** R-multiple after fees and slippage on both fills. */
  netR: number;
}

export interface ReplayResult {
  trades: Trade[];
  /** Signals still running when the data ended. They are left out of the numbers. */
  openAtEnd: number;
  /** The signals still running when the data ended (also used to build the demo data). */
  open: Signal[];
}

export interface ReplayOptions {
  symbol: Symbol;
  /** Closed candles, oldest first. Must reach back far enough for the 1D EMA200. */
  series: MtfSeries;
  /** Signals are looked for only on 1H candles that opened at or after this time. */
  startTime: number;
  config: EngineConfig;
  timeStopHours: number;
  costs?: CostModel;
}

/** R-multiple after costs: entry and exit fills move against the trade by the slippage, and each side pays the fee. */
export function netResultR(side: Signal["side"], entry: number, sl: number, exit: number, costs: CostModel): number {
  const risk = Math.abs(entry - sl);
  const buy = side === "BUY";
  const entryFill = buy ? entry * (1 + costs.slippage) : entry * (1 - costs.slippage);
  const exitFill = buy ? exit * (1 - costs.slippage) : exit * (1 + costs.slippage);
  const gross = buy ? exitFill - entryFill : entryFill - exitFill;
  const fees = costs.feePerSide * (entryFill + exitFill);
  return (gross - fees) / risk;
}

/**
 * Walks the 1H candles one by one, exactly as the live service does: first running signals are advanced with the candle,
 * then the engine looks at that candle's close. Indicators and higher-timeframe values only use candles closed by then,
 * so there is no lookahead.
 */
export function replay(opts: ReplayOptions): ReplayResult {
  const { symbol, series, config } = opts;
  const costs = opts.costs ?? DEFAULT_COSTS;
  const ctx = prepareContext(symbol, series);
  let running: Signal[] = [];
  const trades: Trade[] = [];
  let counter = 0;

  for (let i = 1; i < series.h1.length; i++) {
    const candle = series.h1[i]!;

    // 1. advance running signals with this candle
    const still: Signal[] = [];
    for (const s of running) {
      if (candle.time < s.createdAt) {
        still.push(s);
        continue;
      }
      const next = advance(s, { high: candle.high, low: candle.low, close: candle.close, at: candle.time + HOUR_MS }, opts.timeStopHours).signal;
      if (isActive(next)) {
        still.push(next);
      } else {
        const last = next.statusHistory![next.statusHistory!.length - 1]!;
        trades.push({
          signal: next,
          exitStatus: next.status,
          exitPrice: last.price,
          grossR: next.resultR ?? 0,
          netR: round2(netResultR(next.side, next.entry!, next.sl!, last.price, costs)),
        });
      }
    }
    running = still;

    // 2. look for a new signal at this candle's close
    if (candle.time < opts.startTime) continue;
    const outcome = evaluateAt(ctx, i, {
      config,
      hasOpen: (sym, side) => running.some((s) => s.symbol === sym && s.side === side),
      idFactory: () => `bt-${symbol}-${++counter}`,
    });
    if (outcome.signal) running.push(outcome.signal);
  }
  return { trades, openAtEnd: running.length, open: running };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PartMetrics {
  trades: number;
  /** Share of trades that reached TP1 or better (the app's definition of a win). */
  winRate: number | null;
  /** Share of trades with a positive result after costs. */
  profitableRate: number | null;
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  tradesPerMonth: number;
  longestLosingStreak: number;
}

/** Numbers for a group of trades, using the R after costs, in the order the trades closed. */
export function metrics(trades: Trade[], months: number): PartMetrics {
  const ordered = [...trades].sort((a, b) => (a.signal.closedAt ?? 0) - (b.signal.closedAt ?? 0));
  const rs = ordered.map((t) => t.netR);
  const gains = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  let equity = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let longest = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    streak = r < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const n = trades.length;
  return {
    trades: n,
    winRate: n ? round2((trades.filter((t) => reachedTp1(t.signal)).length / n) * 100) : null,
    profitableRate: n ? round2((rs.filter((r) => r > 0).length / n) * 100) : null,
    avgR: n ? round2(rs.reduce((a, b) => a + b, 0) / n) : null,
    profitFactor: losses > 0 ? round2(gains / losses) : null,
    maxDrawdownR: round2(dd),
    tradesPerMonth: months > 0 ? round2(n / months) : 0,
    longestLosingStreak: longest,
  };
}

export interface Thresholds {
  minProfitFactor: number;
  minTrades: number;
  maxDrawdownR: number;
}

export interface Verdict {
  verdict: "PASS" | "FAIL";
  checks: Array<{ name: string; need: string; got: string; ok: boolean }>;
}

/** PASS needs, on the out-of-sample part only: profit factor, number of trades and drawdown all within the thresholds. */
export function judge(outOfSample: PartMetrics, t: Thresholds): Verdict {
  // No losing trade at all gives an unbounded profit factor, which passes if there are trades.
  const pf = outOfSample.profitFactor ?? (outOfSample.trades > 0 ? Number.POSITIVE_INFINITY : 0);
  const checks = [
    { name: "profit factor", need: `>= ${t.minProfitFactor}`, got: outOfSample.profitFactor === null ? (outOfSample.trades > 0 ? "no losses" : "n/a") : String(outOfSample.profitFactor), ok: pf >= t.minProfitFactor },
    { name: "trades", need: `>= ${t.minTrades}`, got: String(outOfSample.trades), ok: outOfSample.trades >= t.minTrades },
    { name: "max drawdown (R)", need: `<= ${t.maxDrawdownR}`, got: String(outOfSample.maxDrawdownR), ok: outOfSample.maxDrawdownR <= t.maxDrawdownR },
  ];
  return { verdict: checks.every((c) => c.ok) ? "PASS" : "FAIL", checks };
}

export interface BacktestReport {
  symbol: string;
  generatedAt: string;
  provider: string;
  months: number;
  range: { from: string; to: string; splitAt: string };
  costs: CostModel;
  engine: EngineConfig & { timeStopHours: number };
  inSample: PartMetrics;
  outOfSample: PartMetrics;
  thresholds: Thresholds;
  checks: Verdict["checks"];
  verdict: "PASS" | "FAIL";
  openAtEnd: number;
  note: string;
  trades: Array<{ createdAt: string; side: string; score: number | undefined; entry: number; sl: number; exitStatus: string; exitPrice: number; grossR: number; netR: number; part: "in-sample" | "out-of-sample" }>;
}

export const REPORT_NOTE =
  "The first 70% of the period is in-sample and the last 30% is out-of-sample. The engine rules and settings were NOT changed after looking at the out-of-sample result. R-multiples include fees and slippage.";

/** Splits trades by the time the signal was created: before `splitAt` is in-sample, the rest is out-of-sample. */
export function splitTrades(trades: Trade[], splitAt: number): { inSample: Trade[]; outOfSample: Trade[] } {
  return {
    inSample: trades.filter((t) => t.signal.createdAt < splitAt),
    outOfSample: trades.filter((t) => t.signal.createdAt >= splitAt),
  };
}

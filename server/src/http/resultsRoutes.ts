import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { SYMBOLS, symbolSchema } from "../config/symbols.js";
import { latestBacktest } from "../signals/backtestStore.js";
import { isActive } from "../signals/lifecycle.js";
import { computeStats, reachedTp1 } from "../signals/stats.js";
import type { SignalStore } from "../signals/store.js";
import type { Signal } from "../types/index.js";
import { validate } from "./validate.js";

const query = z.object({ symbol: symbolSchema.optional() });

/** How many past trades each kind of visitor may see per list. */
export const RESULTS_ACCESS = { guest: 5, user: 100 } as const;

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

interface Group {
  closed: number;
  wins: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
}

function group(signals: Signal[]): Group {
  const closed = signals.filter((s) => !isActive(s) && typeof s.resultR === "number");
  const totalR = closed.reduce((sum, s) => sum + (s.resultR as number), 0);
  const wins = closed.filter(reachedTp1).length;
  return {
    closed: closed.length,
    wins,
    winRate: closed.length ? round((wins / closed.length) * 100, 1) : null,
    totalR: round(totalR, 2),
    avgR: closed.length ? round(totalR / closed.length, 2) : null,
  };
}

/** Whole-period numbers for a saved backtest: win rate (reached TP1) weighted over both parts, and the mean R of all trades. */
function overall(report: Report): { trades: number; winRate: number | null; avgR: number | null } {
  const parts = [report.inSample, report.outOfSample].filter((p): p is { trades: number; winRate: number | null } => typeof (p as { trades?: unknown } | undefined)?.trades === "number");
  const n = parts.reduce((s, p) => s + p.trades, 0);
  const weighted = parts.filter((p) => p.winRate !== null).reduce((s, p) => s + (p.winRate as number) * p.trades, 0);
  const trades = report.trades ?? [];
  return {
    trades: n,
    winRate: n > 0 ? round(weighted / n, 1) : null,
    avgR: trades.length ? round(trades.reduce((s, t) => s + t.netR, 0) / trades.length, 2) : null,
  };
}

interface Report {
  symbol: string;
  months?: number;
  range?: { from: string; to: string; splitAt: string };
  engine?: { stopBufferAtr?: number; timeframe?: string; minScore?: number };
  inSample?: unknown;
  outOfSample?: unknown;
  verdict?: string;
  trades?: Array<{ createdAt: string; side: string; score?: number; entry: number; sl: number; tp1?: number; tp2?: number; tp3?: number; exitStatus: string; exitPrice?: number; netR: number; part: string }>;
}

export interface ResultsRouterDeps {
  signals: SignalStore;
  /** Folder with backtest reports (<SYMBOL>-<date>.json). */
  backtestDir: string;
}

/**
 * The Results page: how the technique did on live signals, and what it would have done on past charts (the saved backtests).
 * Test signals are never counted. Guests see the numbers and the newest 5 trades; signed-in users see up to 100.
 */
export function createResultsRouter(d: ResultsRouterDeps): Router {
  const router = Router();

  router.get("/results", validate({ query }), (req, res) => {
    const { symbol } = req.query as unknown as z.infer<typeof query>;
    const signedIn = Boolean(req.user);
    const cap = signedIn ? RESULTS_ACCESS.user : RESULTS_ACCESS.guest;
    const symbols = symbol ? [symbol] : [...SYMBOLS];

    const all = d.signals.all().filter((s) => !s.test && (!symbol || s.symbol === symbol));
    const closed = all.filter((s) => !isActive(s) && typeof s.resultR === "number").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

    const months = new Map<string, Signal[]>();
    for (const s of closed) {
      const key = new Date(s.closedAt ?? s.createdAt).toISOString().slice(0, 7);
      months.set(key, [...(months.get(key) ?? []), s]);
    }

    const backtests = symbols.flatMap((sym) => {
      const found = latestBacktest(d.backtestDir, sym);
      if (!found) return [];
      const file = join(d.backtestDir, found.file);
      if (!existsSync(file)) return [];
      let report: Report;
      try {
        report = JSON.parse(readFileSync(file, "utf8")) as Report;
      } catch {
        return [];
      }
      const trades = [...(report.trades ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return [
        {
          symbol: sym,
          date: found.date,
          verdict: found.verdict,
          months: report.months ?? null,
          from: report.range?.from ?? null,
          to: report.range?.to ?? null,
          splitAt: report.range?.splitAt ?? null,
          timeframe: report.engine?.timeframe ?? "1h",
          stopBufferAtr: report.engine?.stopBufferAtr ?? 0.5,
          minScore: report.engine?.minScore ?? null,
          inSample: report.inSample ?? null,
          outOfSample: report.outOfSample ?? null,
          tradesTotal: trades.length,
          overall: overall(report),
          trades: trades.slice(0, cap).map((t) => ({
            createdAt: t.createdAt,
            side: t.side,
            score: t.score ?? null,
            entry: t.entry,
            sl: t.sl,
            tp1: t.tp1 ?? null,
            tp2: t.tp2 ?? null,
            tp3: t.tp3 ?? null,
            exitStatus: t.exitStatus,
            exitPrice: t.exitPrice ?? null,
            netR: t.netR,
            part: t.part,
          })),
        },
      ];
    });

    res.json({
      role: req.user?.role ?? "guest",
      cap,
      locked: !signedIn,
      live: {
        overall: computeStats(all),
        totalR: group(all).totalR,
        bySymbol: symbols.map((sym) => ({ symbol: sym, ...group(all.filter((s) => s.symbol === sym)) })),
        byMonth: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, list]) => ({ month, ...group(list) })),
        recent: closed.slice(0, cap).map((s) => ({
          id: s.id,
          symbol: s.symbol,
          side: s.side,
          status: s.status,
          resultR: s.resultR,
          score: s.score ?? null,
          createdAt: s.createdAt,
          closedAt: s.closedAt ?? null,
          mode: s.mode ?? null,
          entry: s.entry ?? s.price,
          sl: s.sl ?? null,
          tp1: s.tp1 ?? null,
          tp2: s.tp2 ?? null,
          tp3: s.tp3 ?? null,
          exitPrice: s.statusHistory && s.statusHistory.length > 1 ? s.statusHistory[s.statusHistory.length - 1]!.price : null,
        })),
      },
      backtest: backtests,
    });
  });

  return router;
}

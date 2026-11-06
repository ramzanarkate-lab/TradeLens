import type { Signal, SignalStatus } from "../types/index.js";
import { isActive } from "./lifecycle.js";

export interface SignalStats {
  total: number;
  open: number;
  closed: number;
  /** Closed signals that reached TP1 or better. */
  wins: number;
  /** Percent of closed signals that reached TP1 or better (one decimal). Null when nothing has closed. */
  winRate: number | null;
  /** Mean final R of closed signals. */
  avgR: number | null;
  /** Sum of positive R divided by the sum of negative R. Null when there is no loss yet. */
  profitFactor: number | null;
  /** Largest fall of the running total of R (closed signals in order of closing), as a positive number. */
  maxDrawdownR: number;
  countByStatus: Record<SignalStatus, number>;
}

const STATUSES: SignalStatus[] = ["OPEN", "TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT", "BREAKEVEN_EXIT", "TIME_EXIT"];
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** A signal counts as a win when it reached TP1 or better, even if the rest of the trade was later stopped at breakeven. */
export const reachedTp1 = (s: Signal): boolean => (s.statusHistory ?? []).some((c) => c.status === "TP1_HIT");

/** The numbers shown in the app and in the backtest report. `resultR` of a closed signal is used as is. */
export function computeStats(signals: Signal[]): SignalStats {
  const countByStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<SignalStatus, number>;
  for (const s of signals) countByStatus[s.status ?? "OPEN"]++;

  const closed = signals.filter((s) => !isActive(s) && s.resultR !== null && s.resultR !== undefined);
  const byClose = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const rs = byClose.map((s) => s.resultR as number);

  const gains = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const wins = closed.filter(reachedTp1).length;
  return {
    total: signals.length,
    open: signals.filter(isActive).length,
    closed: closed.length,
    wins,
    winRate: closed.length ? round((wins / closed.length) * 100, 1) : null,
    avgR: closed.length ? round(rs.reduce((a, b) => a + b, 0) / closed.length, 2) : null,
    profitFactor: losses > 0 ? round(gains / losses, 2) : null,
    maxDrawdownR: round(maxDd, 2),
    countByStatus,
  };
}

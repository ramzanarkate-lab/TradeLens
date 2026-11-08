import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BacktestSummary {
  symbol: string;
  file: string;
  verdict: "PASS" | "FAIL";
  /** Date in the file name (YYYY-MM-DD). */
  date: string;
}

/** The newest backtest report for a symbol in `dir` (files are named <symbol>-<YYYY-MM-DD>.json), or null. */
export function latestBacktest(dir: string, symbol: string): BacktestSummary | null {
  if (!existsSync(dir)) return null;
  const pattern = new RegExp(`^${symbol}-(\\d{4}-\\d{2}-\\d{2})(?:-\\d+)?\\.json$`);
  const matches = readdirSync(dir)
    .map((name) => ({ name, m: pattern.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const newest = matches[matches.length - 1];
  if (!newest) return null;
  try {
    const report = JSON.parse(readFileSync(join(dir, newest.name), "utf8")) as { verdict?: string };
    if (report.verdict !== "PASS" && report.verdict !== "FAIL") return null;
    return { symbol, file: newest.name, verdict: report.verdict, date: newest.m[1]! };
  } catch {
    return null;
  }
}

export interface BacktestTradeSummary {
  createdAt: string;
  side: string;
  score: number | null;
  entry: number;
  sl: number;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  exitStatus: string;
  exitPrice: number | null;
  netR: number;
}

/** The newest trade of the latest saved backtest for a symbol: what the technique last did on a past chart. Null if there is none. */
export function lastBacktestTrade(dir: string, symbol: string): BacktestTradeSummary | null {
  const found = latestBacktest(dir, symbol);
  if (!found) return null;
  try {
    const report = JSON.parse(readFileSync(join(dir, found.file), "utf8")) as { trades?: Array<Record<string, unknown>> };
    const newest = [...(report.trades ?? [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!newest) return null;
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      createdAt: String(newest.createdAt),
      side: String(newest.side),
      score: num(newest.score),
      entry: Number(newest.entry),
      sl: Number(newest.sl),
      tp1: num(newest.tp1),
      tp2: num(newest.tp2),
      tp3: num(newest.tp3),
      exitStatus: String(newest.exitStatus ?? ""),
      exitPrice: num(newest.exitPrice),
      netR: Number(newest.netR),
    };
  } catch {
    return null;
  }
}

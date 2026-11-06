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

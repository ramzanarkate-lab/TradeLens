/**
 * Backtests all 12 strategies on the same symbols, each on its own timeframe, one time, before any signal is routed.
 *   npx tsx scripts/strategy-backtest.ts
 * Candles: 1h and 4h from data/history-long (5 years: run scripts/fetch-long.ts first), 15m from data/history (12 months).
 * Fees 0.1% per side, slippage 0.05% per fill. The first 70% of each period is in-sample, the last 30% out-of-sample.
 * The rules are locked: nothing is tuned and a strategy that fails stays NOT PASSED. Results go to data/strategy-backtests.json.
 * Only a run of this script can change a strategy's status.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYMBOLS } from "../src/config/symbols.js";
import { newBacktestFile, saveBacktestFile } from "../src/strategies/backtestStore.js";
import { runAllBacktests } from "../src/strategies/runBacktest.js";
import type { StrategyTimeframe } from "../src/strategies/types.js";
import type { Candle } from "../src/types/index.js";

const root = resolve(import.meta.dirname, "..");
const MONTHS: Record<StrategyTimeframe, number> = { "15m": 12, "1h": 60, "4h": 60 };

function loadCandles(symbol: string, tf: StrategyTimeframe): Candle[] {
  const dir = tf === "15m" ? "data/history" : "data/history-long";
  const file = resolve(root, dir, `${symbol}-${tf}.json`);
  if (!existsSync(file)) throw new Error(`${file} is missing${tf === "15m" ? "" : ": run scripts/fetch-long.ts first"}`);
  return (JSON.parse(readFileSync(file, "utf8")) as Candle[]).filter((c) => c.closed !== false).sort((a, b) => a.time - b.time);
}

const rows = runAllBacktests({ symbols: SYMBOLS, months: MONTHS, loadCandles });
saveBacktestFile(resolve(root, "data/strategy-backtests.json"), newBacktestFile(60, rows));

const f = (v: number | null) => (v === null ? "n/a" : String(v));
console.log(`\n${"strategy".padEnd(24)}${"symbol".padEnd(9)}${"tf".padEnd(4)}${"IS exp(R)".padStart(10)}${"OOS exp(R)".padStart(11)}${"OOS n".padStart(7)}${"PF".padStart(6)}${"maxDD(R)".padStart(9)}  status`);
for (const r of rows) {
  console.log(`${r.strategyId.padEnd(24)}${r.symbol.padEnd(9)}${r.timeframe.padEnd(4)}${f(r.inSample.expectancyR).padStart(10)}${f(r.outOfSample.expectancyR).padStart(11)}${String(r.outOfSample.trades).padStart(7)}${f(r.outOfSample.profitFactor).padStart(6)}${String(r.outOfSample.maxDrawdownR).padStart(9)}  ${r.status}`);
}
console.log("\nSaved to data/strategy-backtests.json");

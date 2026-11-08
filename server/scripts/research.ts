/**
 * Strategy research on the cached history (no network). Settings are CHOSEN on the in-sample part only (first 70%);
 * the out-of-sample part (last 30%) is only reported for the chosen settings and for every symbol.
 *   npx tsx scripts/research.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_COSTS, metrics, replay, splitTrades } from "../src/backtest/backtest.js";
import type { Symbol } from "../src/config/symbols.js";
import { prepareContext, type EngineConfig } from "../src/signals/engine.v2.js";
import { DAY_MS, HOUR_MS, TRIGGER_MS, type TriggerTimeframe } from "../src/signals/mtf.js";
import type { Candle } from "../src/types/index.js";

const dir = resolve(import.meta.dirname, "../data/history");
const load = (symbol: string, interval: string): Candle[] => {
  const file = resolve(dir, `${symbol}-${interval}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Candle[]) : [];
};

const SYMBOLS: Symbol[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const MONTHS = 12;
const reversal = { enabled: true, minVolumeRatio: 1.2, levelToleranceAtr: 0.5, patterns: { hammer: true, engulfing: true, piercing: true, morningStar: true, tweezer: true } };

interface Grid {
  tf: TriggerTimeframe;
  minScore: number;
  minRisk: number;
  targetScale: number;
  stopBuffer: number;
  timeStopHours: number;
  reversal: boolean;
}

function evalGrid(symbol: Symbol, g: Grid) {
  const h4 = load(symbol, "4h");
  const d1 = load(symbol, "1d");
  const trig = g.tf === "4h" ? h4 : load(symbol, g.tf);
  if (!trig.length || !h4.length || !d1.length) return null;
  const end = trig[trig.length - 1]!.time + TRIGGER_MS[g.tf];
  const startTime = Math.floor((end - MONTHS * 30.4375 * DAY_MS) / HOUR_MS) * HOUR_MS;
  const splitAt = Math.floor((startTime + (end - startTime) * 0.7) / HOUR_MS) * HOUR_MS;
  const span = (end - startTime) / (30.4375 * DAY_MS);
  const series = { h1: trig, h4, d1 };
  const config: EngineConfig = {
    minScore: g.minScore,
    minRiskPercent: g.minRisk,
    maxRiskPercent: 4,
    stopBufferAtr: g.stopBuffer,
    targetScale: g.targetScale,
    mode: "paper",
    ...(g.reversal ? { reversal } : {}),
  };
  const { trades } = replay({ symbol, series, startTime, config, timeStopHours: g.timeStopHours, costs: DEFAULT_COSTS, timeframe: g.tf, context: prepareContext(symbol, series, g.tf) });
  const parts = splitTrades(trades, splitAt);
  return { inM: metrics(parts.inSample, span * 0.7), outM: metrics(parts.outOfSample, span * 0.3) };
}

const fmt = (m: { trades: number; avgR: number | null; profitFactor: number | null; maxDrawdownR: number }) => `n=${String(m.trades).padStart(3)} avgR=${String(m.avgR).padStart(6)} PF=${String(m.profitFactor).padStart(5)} DD=${String(m.maxDrawdownR).padStart(5)}`;

const mode = process.argv[2] ?? "grid";
const base: Grid = { tf: "15m", minScore: 70, minRisk: 0.4, targetScale: 1, stopBuffer: 0.5, timeStopHours: 48, reversal: true };

if (mode === "base") {
  for (const tf of ["15m", "1h", "4h"] as const) for (const s of SYMBOLS) {
    const r = evalGrid(s, { ...base, tf });
    if (r) console.log(tf, s, "IN", fmt(r.inM), "| OUT", fmt(r.outM));
  }
} else {
  // choose on in-sample, pooled over the three symbols (a setting must work on all of them, not just one)
  const rows: Array<{ g: Grid; pf: number; avgR: number; n: number; dd: number }> = [];
  for (const tf of ["1h", "4h"] as const)
    for (const minScore of [70, 80])
      for (const minRisk of [0.4, 0.8, 1.2])
        for (const targetScale of [1, 1.5, 2])
          for (const stopBuffer of [0.5, 1.0])
            for (const rev of [true, false]) {
              const g: Grid = { ...base, tf, minScore, minRisk, targetScale, stopBuffer, reversal: rev };
              let n = 0, sumR = 0, dd = 0;
              for (const s of SYMBOLS) {
                const r = evalGrid(s, g);
                if (!r) continue;
                n += r.inM.trades;
                sumR += (r.inM.avgR ?? 0) * r.inM.trades;
                dd = Math.max(dd, r.inM.maxDrawdownR);
              }
              if (n >= 60) rows.push({ g, pf: Math.round((sumR / n) * 1000) / 1000, avgR: sumR / n, n, dd });
            }
  rows.sort((a, b) => b.avgR - a.avgR);
  console.log("TOP 12 by in-sample pooled average R (3 symbols):");
  for (const r of rows.slice(0, 12)) console.log(JSON.stringify(r.g), `avgR=${r.avgR.toFixed(3)} n=${r.n} maxDD=${r.dd}`);
  const best = rows[0]!.g;
  console.log("\nBEST settings", JSON.stringify(best), "\nPer symbol (in-sample was used to choose; OUT is unseen):");
  for (const s of SYMBOLS) {
    const r = evalGrid(s, best);
    if (r) console.log(s, "IN", fmt(r.inM), "| OUT", fmt(r.outM));
  }
}

/**
 * Honest parameter search. Looks for settings with a higher win rate without hiding what it costs.
 *   npm run search            (uses the cached history in data/history; run npm run backtest once first to download it)
 *
 * Rules of the search, fixed BEFORE looking at any result:
 *  1. Every setting combination is scored on the IN-SAMPLE part only (the first 70% of 12 months), all three symbols pooled.
 *  2. A combination needs at least 60 in-sample trades to count.
 *  3. The candidates are the top 3 by in-sample win rate and the top 3 by in-sample profit factor.
 *  4. Only those candidates (and the current defaults) are then run on the OUT-OF-SAMPLE part, once. Nothing is re-tuned after that.
 * Win rate = share of trades that reached TP1 or better. Profit factor and average R are net of fees (0.1% per side) and slippage (0.05%).
 * Nothing here changes the live engine: the output is a report in data/search/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COSTS, metrics, replay, splitTrades, type PartMetrics, type Trade } from "../src/backtest/backtest.js";
import { SYMBOLS, type Symbol } from "../src/config/symbols.js";
import { prepareContext, type EngineConfig, type EngineContext } from "../src/signals/engine.v2.js";
import { ALL_PATTERNS_ON } from "../src/signals/patterns.js";
import { DAY_MS, HOUR_MS, TRIGGER_MS, type MtfSeries, type TriggerTimeframe } from "../src/signals/mtf.js";
import type { Candle } from "../src/types/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historyDir = resolve(root, "data", "history");
const MONTHS = 12;
const MIN_IN_SAMPLE_TRADES = 60;

function load(symbol: Symbol, interval: string): Candle[] {
  const file = resolve(historyDir, `${symbol}-${interval}.json`);
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run: npm run backtest -- --symbol ${symbol} --months 12`);
  return JSON.parse(readFileSync(file, "utf8")) as Candle[];
}

interface Setting {
  timeframe: TriggerTimeframe;
  stopBufferAtr: number;
  minScore: number;
  reversal: boolean;
  targetScale: number;
}
const label = (s: Setting) => `${s.timeframe} stopBuf ${s.stopBufferAtr} minScore ${s.minScore} reversal ${s.reversal ? "on" : "off"} targets x${s.targetScale}`;

const GRID = {
  timeframe: ["1h", "4h"] as TriggerTimeframe[],
  stopBufferAtr: [0.5, 1.0, 1.5, 2.0],
  minScore: [70, 80, 90],
  reversal: [false, true],
  targetScale: [1, 0.6, 0.4],
};
const DEFAULT: Setting = { timeframe: "1h", stopBufferAtr: 0.5, minScore: 70, reversal: true, targetScale: 1 };

// ---- data: the same 12-month window and 70/30 split for every symbol
const data = new Map<Symbol, { h4: Candle[]; d1: Candle[]; h1: Candle[] }>();
for (const s of SYMBOLS) data.set(s, { h1: load(s, "1h"), h4: load(s, "4h"), d1: load(s, "1d") });
const lastH1 = Math.min(...SYMBOLS.map((s) => data.get(s)!.h1.at(-1)!.time + HOUR_MS));
const startTime = Math.floor((lastH1 - MONTHS * 30.4375 * DAY_MS) / HOUR_MS) * HOUR_MS;
const splitAt = Math.floor((startTime + (lastH1 - startTime) * 0.7) / HOUR_MS) * HOUR_MS;
const spanMonths = (lastH1 - startTime) / (30.4375 * DAY_MS);

const contexts = new Map<string, { ctx: EngineContext; series: MtfSeries }>();
function context(symbol: Symbol, tf: TriggerTimeframe) {
  const key = `${symbol}:${tf}`;
  let c = contexts.get(key);
  if (!c) {
    const d = data.get(symbol)!;
    const series: MtfSeries = { h1: tf === "4h" ? d.h4 : d.h1, h4: d.h4, d1: d.d1 };
    c = { ctx: prepareContext(symbol, series, tf), series };
    contexts.set(key, c);
  }
  return c;
}

function runAll(s: Setting): Trade[] {
  const config: EngineConfig = {
    minScore: s.minScore,
    minRiskPercent: 0.4,
    maxRiskPercent: 4.0,
    mode: "paper",
    stopBufferAtr: s.stopBufferAtr,
    targetScale: s.targetScale,
    ...(s.reversal ? { reversal: { enabled: true, minVolumeRatio: 1.2, levelToleranceAtr: 0.5, patterns: ALL_PATTERNS_ON } } : {}),
  };
  return SYMBOLS.flatMap((symbol) => {
    const { ctx, series } = context(symbol, s.timeframe);
    return replay({ symbol, series, startTime, config, timeStopHours: 48, costs: DEFAULT_COSTS, timeframe: s.timeframe, context: ctx }).trades;
  });
}

const part = (trades: Trade[], inSample: boolean): PartMetrics => {
  const { inSample: a, outOfSample: b } = splitTrades(trades, splitAt);
  return metrics(inSample ? a : b, spanMonths * (inSample ? 0.7 : 0.3));
};
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : String(v));

// ---- 1. score every setting on the in-sample part only
const combos: Setting[] = [];
for (const timeframe of GRID.timeframe) for (const stopBufferAtr of GRID.stopBufferAtr) for (const minScore of GRID.minScore) for (const reversal of GRID.reversal) for (const targetScale of GRID.targetScale) combos.push({ timeframe, stopBufferAtr, minScore, reversal, targetScale });
console.log(`Window ${new Date(startTime).toISOString().slice(0, 10)} to ${new Date(lastH1).toISOString().slice(0, 10)}, split at ${new Date(splitAt).toISOString().slice(0, 10)}. ${combos.length} settings x ${SYMBOLS.length} symbols, scored on the IN-SAMPLE part only.`);

interface Scored {
  setting: Setting;
  inM: PartMetrics;
  trades: Trade[];
}
const scored: Scored[] = [];
let done = 0;
for (const setting of combos) {
  const trades = runAll(setting);
  scored.push({ setting, trades, inM: part(trades, true) });
  if (++done % 24 === 0) console.log(`  ${done}/${combos.length} settings scored`);
}
const eligible = scored.filter((s) => s.inM.trades >= MIN_IN_SAMPLE_TRADES);
console.log(`${eligible.length} of ${scored.length} settings have at least ${MIN_IN_SAMPLE_TRADES} in-sample trades.`);

const byWin = [...eligible].sort((a, b) => (b.inM.winRate ?? 0) - (a.inM.winRate ?? 0));
const byPf = [...eligible].sort((a, b) => (b.inM.profitFactor ?? 0) - (a.inM.profitFactor ?? 0));
const show = (title: string, list: Scored[]) => {
  console.log(`\n${title}`);
  console.log("  win%   profitF  avgR     trades  setting");
  for (const s of list.slice(0, 8)) console.log(`  ${String(s.inM.winRate).padEnd(6)} ${fmt(s.inM.profitFactor).padEnd(8)} ${String(s.inM.avgR).padEnd(8)} ${String(s.inM.trades).padEnd(7)} ${label(s.setting)}`);
};
show("IN-SAMPLE, best by WIN RATE", byWin);
show("IN-SAMPLE, best by PROFIT FACTOR", byPf);
const bestInSampleWin = byWin[0]?.inM.winRate ?? 0;
console.log(`\nHighest in-sample win rate found: ${bestInSampleWin}%  (target was 80%: ${bestInSampleWin >= 80 ? "reached in-sample" : "NOT reached"}).`);
console.log(`Settings with in-sample profit factor above 1.0: ${eligible.filter((s) => (s.inM.profitFactor ?? 0) > 1).length}.`);

// ---- 2. the candidates, once, on the out-of-sample part
const pick = new Map<string, Scored>();
for (const s of [...byWin.slice(0, 3), ...byPf.slice(0, 3)]) pick.set(label(s.setting), s);
const baseline = scored.find((s) => label(s.setting) === label(DEFAULT))!;
pick.set(`DEFAULTS: ${label(DEFAULT)}`, baseline);

console.log("\nOUT-OF-SAMPLE (last 30%), checked once, nothing re-tuned afterwards");
console.log("  win%   profitF  avgR     maxDD(R) trades  setting");
const results = [] as Array<{ setting: string; inSample: PartMetrics; outOfSample: PartMetrics }>;
for (const [name, s] of pick) {
  const out = part(s.trades, false);
  results.push({ setting: name, inSample: s.inM, outOfSample: out });
  console.log(`  ${fmt(out.winRate).padEnd(6)} ${fmt(out.profitFactor).padEnd(8)} ${fmt(out.avgR).padEnd(8)} ${String(out.maxDrawdownR).padEnd(8)} ${String(out.trades).padEnd(7)} ${name}`);
}
const reached = results.filter((r) => (r.outOfSample.winRate ?? 0) >= 80 && r.outOfSample.trades >= 30);
console.log(`\nCandidates with out-of-sample win rate of 80% or more and at least 30 trades: ${reached.length}.`);
const profitable = results.filter((r) => (r.outOfSample.profitFactor ?? 0) > 1);
console.log(`Candidates with out-of-sample profit factor above 1.0: ${profitable.length}.`);
console.log("A high win rate alone does not mean profit: compare it with profit factor and average R.");

const outDir = resolve(root, "data", "search");
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `search-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ window: { from: new Date(startTime).toISOString(), to: new Date(lastH1).toISOString(), splitAt: new Date(splitAt).toISOString() }, grid: GRID, results, note: "Selected on in-sample only; out-of-sample checked once. Live engine unchanged." }, null, 2));
console.log(`Report: ${file}`);
void TRIGGER_MS;

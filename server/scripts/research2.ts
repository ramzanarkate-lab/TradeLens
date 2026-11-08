/**
 * Research part 2: exits and a different entry. Everything is net of the same fees and slippage as the app's backtest.
 * Choice is made on the first 70% (in-sample), pooled over BTC, ETH and SOL. The last 30% is reported, never used to choose.
 *   npx tsx scripts/research2.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_COSTS, netResultR, replay } from "../src/backtest/backtest.js";
import type { Symbol } from "../src/config/symbols.js";
import { prepareContext } from "../src/signals/engine.v2.js";
import { atr, ema } from "../src/signals/indicators.js";
import { DAY_MS, HOUR_MS } from "../src/signals/mtf.js";
import type { Candle } from "../src/types/index.js";

const LONG = process.env.LONG === "1";
const dir = resolve(import.meta.dirname, LONG ? "../data/history-long" : "../data/history");
const load = (s: string, i: string): Candle[] => {
  const f = resolve(dir, `${s}-${i}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Candle[]) : [];
};
const SYMBOLS: Symbol[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const MONTHS = LONG ? 60 : 12;

interface T {
  at: number;
  r: number;
}
interface Stat {
  n: number;
  avgR: number;
  pf: number;
  dd: number;
  total: number;
}
function stat(ts: T[]): Stat {
  const rs = [...ts].sort((a, b) => a.at - b.at).map((t) => t.r);
  const g = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const l = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  let eq = 0, pk = 0, dd = 0;
  for (const r of rs) { eq += r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const total = rs.reduce((a, b) => a + b, 0);
  return { n: rs.length, avgR: rs.length ? total / rs.length : 0, pf: l > 0 ? g / l : g > 0 ? 99 : 0, dd, total };
}
const f = (s: Stat) => `n=${String(s.n).padStart(3)} avgR=${s.avgR.toFixed(2).padStart(5)} PF=${s.pf.toFixed(2).padStart(5)} totR=${s.total.toFixed(1).padStart(6)} DD=${s.dd.toFixed(1).padStart(5)}`;

/** Walk candles after an entry: initial stop, optional break-even, trailing stop at `trail` x R behind the best price, time stop. */
function trailExit(side: "BUY" | "SELL", entry: number, sl: number, candles: Candle[], from: number, trailR: number, maxBars: number): { exit: number; at: number } {
  const risk = Math.abs(entry - sl);
  const buy = side === "BUY";
  let stop = sl;
  let best = entry;
  for (let k = from; k < Math.min(candles.length, from + maxBars); k++) {
    const c = candles[k]!;
    if (buy ? c.low <= stop : c.high >= stop) return { exit: stop, at: c.time };
    best = buy ? Math.max(best, c.high) : Math.min(best, c.low);
    const gained = buy ? best - entry : entry - best;
    if (gained >= 1 * risk) {
      const trail = buy ? best - trailR * risk : best + trailR * risk;
      stop = buy ? Math.max(stop, trail, entry) : Math.min(stop, trail, entry);
    }
  }
  const last = candles[Math.min(candles.length, from + maxBars) - 1]!;
  return { exit: last.close, at: last.time };
}

/** A: the app's own entries (1H, score 70, no reversal, wide stop) with a trailing exit instead of the 1R/2R/3R ladder. */
function strategyA(symbol: Symbol, trailR: number, maxBars: number, minScore: number): { t: T[]; split: number } {
  const h4 = load(symbol, "4h"), d1 = load(symbol, "1d"), h1 = load(symbol, "1h");
  const end = h1[h1.length - 1]!.time + HOUR_MS;
  const startTime = Math.floor((end - MONTHS * 30.4375 * DAY_MS) / HOUR_MS) * HOUR_MS;
  const split = Math.floor((startTime + (end - startTime) * 0.7) / HOUR_MS) * HOUR_MS;
  const series = { h1, h4, d1 };
  const config = { minScore, minRiskPercent: 0.4, maxRiskPercent: 4, stopBufferAtr: 1, mode: "paper" as const };
  const { trades, open } = replay({ symbol, series, startTime, config, timeStopHours: 48, costs: DEFAULT_COSTS, timeframe: "1h", context: prepareContext(symbol, series, "1h") });
  const index = new Map(h1.map((c, i) => [c.time, i]));
  const out: T[] = [];
  let busyUntil = { BUY: 0, SELL: 0 };
  for (const s of [...trades.map((x) => x.signal), ...open].sort((a, b) => a.createdAt - b.createdAt)) {
    if (s.createdAt < busyUntil[s.side]) continue; // one position per side at a time
    const from = index.get(s.createdAt) ?? -1;
    if (from < 0) continue;
    const x = trailExit(s.side, s.entry!, s.sl!, h1, from, trailR, maxBars);
    busyUntil = { ...busyUntil, [s.side]: x.at };
    out.push({ at: s.createdAt, r: netResultR(s.side, s.entry!, s.sl!, x.exit, DEFAULT_COSTS) });
  }
  return { t: out, split };
}

/** B: Donchian breakout on 4H in the direction of the 1D EMA200, ATR stop, exit on a shorter opposite channel. */
function strategyB(symbol: Symbol, entryN: number, exitN: number, stopAtr: number): { t: T[]; split: number } {
  const h4 = load(symbol, "4h"), d1 = load(symbol, "1d");
  const end = h4[h4.length - 1]!.time + 4 * HOUR_MS;
  const startTime = Math.floor((end - MONTHS * 30.4375 * DAY_MS) / HOUR_MS) * HOUR_MS;
  const split = Math.floor((startTime + (end - startTime) * 0.7) / HOUR_MS) * HOUR_MS;
  const a = atr(h4, 14);
  const e200 = ema(d1.map((c) => c.close), 200);
  const out: T[] = [];
  let pos: null | { side: "BUY" | "SELL"; entry: number; sl: number; at: number } = null;
  for (let i = Math.max(entryN, exitN) + 1; i < h4.length; i++) {
    const c = h4[i]!;
    if (pos) {
      const buy = pos.side === "BUY";
      const lo = Math.min(...h4.slice(i - exitN, i).map((x) => x.low));
      const hi = Math.max(...h4.slice(i - exitN, i).map((x) => x.high));
      let exit: number | null = null;
      if (buy ? c.low <= pos.sl : c.high >= pos.sl) exit = pos.sl;
      else if (buy ? c.close < lo : c.close > hi) exit = c.close;
      if (exit !== null) {
        out.push({ at: pos.at, r: netResultR(pos.side, pos.entry, pos.sl, exit, DEFAULT_COSTS) });
        pos = null;
      }
      continue;
    }
    if (c.time < startTime) continue;
    const dayIdx = d1.findIndex((d) => d.time + DAY_MS > c.time + 4 * HOUR_MS) - 1; // last fully closed day
    if (dayIdx < 0 || Number.isNaN(e200[dayIdx]!)) continue;
    const trendUp = d1[dayIdx]!.close > e200[dayIdx]!;
    const hh = Math.max(...h4.slice(i - entryN, i).map((x) => x.high));
    const ll = Math.min(...h4.slice(i - entryN, i).map((x) => x.low));
    const risk = stopAtr * a[i]!;
    if (trendUp && c.close > hh) pos = { side: "BUY", entry: c.close, sl: c.close - risk, at: c.time + 4 * HOUR_MS };
    else if (!trendUp && c.close < ll) pos = { side: "SELL", entry: c.close, sl: c.close + risk, at: c.time + 4 * HOUR_MS };
  }
  return { t: out, split };
}

function evaluate(name: string, run: (s: Symbol) => { t: T[]; split: number }) {
  const inT: T[] = [], outT: T[] = [];
  const per: string[] = [];
  for (const s of SYMBOLS) {
    const { t, split } = run(s);
    const i = t.filter((x) => x.at < split), o = t.filter((x) => x.at >= split);
    inT.push(...i); outT.push(...o);
    per.push(`   ${s} IN ${f(stat(i))} | OUT ${f(stat(o))}`);
  }
  return { name, inS: stat(inT), outS: stat(outT), per };
}

const results: ReturnType<typeof evaluate>[] = [];
if (!LONG) for (const trail of [1.5, 2, 3]) for (const maxBars of [72, 168]) for (const minScore of [70, 80]) results.push(evaluate(`A trail=${trail}R maxBars=${maxBars} score=${minScore}`, (s) => strategyA(s, trail, maxBars, minScore)));
for (const en of [20, 40, 55]) for (const ex of [10, 20]) for (const sa of [2, 3]) results.push(evaluate(`B donchian entry=${en} exit=${ex} stop=${sa}xATR`, (s) => strategyB(s, en, ex, sa)));

results.sort((a, b) => b.inS.avgR - a.inS.avgR);
console.log("Ranked by IN-SAMPLE pooled avgR (OUT shown for information only):");
for (const r of results.slice(0, 10)) console.log(`${r.name.padEnd(42)} IN ${f(r.inS)} | OUT ${f(r.outS)}`);
const best = results[0]!;
console.log(`\nCHOSEN on in-sample: ${best.name}`);
for (const l of best.per) console.log(l);

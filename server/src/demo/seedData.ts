import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { SYMBOLS, TIMEFRAMES, type Symbol, type Timeframe } from "../config/symbols.js";
import { TIMEFRAME_MS } from "../market/aggregate.js";
import { replay } from "../backtest/backtest.js";
import { DAY_MS } from "../signals/mtf.js";
import type { Candle, Signal } from "../types/index.js";

/** Candles per symbol and timeframe, oldest first. Stored as plain JSON under data/demo/. */
export type DemoCandles = Record<Symbol, Record<Timeframe, Candle[]>>;

export interface DemoFile {
  /** Epoch ms the sample data was generated; the demo provider shifts times forward from here. */
  generatedAt: number;
  candles: DemoCandles;
}

const BASE_PRICE: Record<Symbol, number> = { BTCUSDT: 65_000, SOLUSDT: 150, ETHUSDT: 3_200 };
const STEP = TIMEFRAME_MS["15m"];
/** 15m candles per symbol: 240 days, so the 1D EMA200 and the 4H indicators the signal engine needs are ready. */
const COUNT = 240 * 96;

/** Small deterministic random numbers (mulberry32), so the same seed gives the same sample data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

function walk15m(symbol: Symbol, lastStart: number, seed: number): Candle[] {
  const next = rng(seed);
  const out: Candle[] = [];
  let price = BASE_PRICE[symbol];
  const first = lastStart - (COUNT - 1) * STEP;
  for (let i = 0; i < COUNT; i++) {
    // A slow sine "trend" plus noise, so EMAs cross now and then and signals appear.
    const drift = Math.sin(i / 180) * 0.0002;
    const open = price;
    const close = open * (1 + drift + (next() - 0.5) * 0.008);
    const high = Math.max(open, close) * (1 + next() * 0.002);
    const low = Math.min(open, close) * (1 - next() * 0.002);
    out.push({
      time: first + i * STEP,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: round(50 + next() * 400),
      closed: true,
    });
    price = close;
  }
  return out;
}

/** Groups 15m candles into `size`-long buckets aligned to the UTC epoch. Only whole buckets are returned. */
function regroup(c15: Candle[], size: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of c15) {
    const start = Math.floor(c.time / size) * size;
    const list = buckets.get(start);
    if (list) list.push(c);
    else buckets.set(start, [c]);
  }
  const per = size / STEP;
  const out: Candle[] = [];
  for (const [time, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length !== per) continue;
    out.push({
      time,
      open: list[0]!.open,
      high: Math.max(...list.map((c) => c.high)),
      low: Math.min(...list.map((c) => c.low)),
      close: list[list.length - 1]!.close,
      volume: round(list.reduce((sum, c) => sum + c.volume, 0)),
      closed: true,
    });
  }
  return out;
}

export function generateCandles(now: number): DemoCandles {
  const lastStart = Math.floor(now / STEP) * STEP - STEP; // last fully closed 15m candle
  const result = {} as DemoCandles;
  SYMBOLS.forEach((symbol, idx) => {
    const c15 = walk15m(symbol, lastStart, 1000 + idx * 7);
    const byTf = {} as Record<Timeframe, Candle[]>;
    for (const tf of TIMEFRAMES) byTf[tf] = tf === "15m" ? c15 : regroup(c15, TIMEFRAME_MS[tf]);
    result[symbol] = byTf;
  });
  return result;
}

/**
 * Signals the real multi-indicator engine produces on the sample candles, with their full lifecycle (closed ones and still-running ones).
 * The score threshold is lowered to 45 so a demo always has signals to look at. All of them are "paper" signals.
 */
export function generateSignals(candles: DemoCandles): Signal[] {
  const all: Signal[] = [];
  for (const symbol of SYMBOLS) {
    const c = candles[symbol];
    const startTime = c["1d"][205]?.time ?? 0; // the 1D EMA200 is ready from here
    const config = { minScore: 45, minRiskPercent: 0.2, maxRiskPercent: 8, mode: "paper" as const };
    const result = replay({ symbol, series: { h1: c["1h"], h4: c["4h"], d1: c["1d"] }, startTime: startTime + DAY_MS, config, timeStopHours: 48 });
    const closed = result.trades.map((t) => t.signal);
    all.push(...closed.slice(-12), ...result.open);
  }
  return all.sort((a, b) => a.createdAt - b.createdAt).slice(-60);
}

export interface SeedResult {
  dir: string;
  candleFile: string;
  signalFile: string;
  candleCount: number;
  signalCount: number;
  buy: number;
  sell: number;
}

/**
 * Writes the sample files. The only place it ever writes is `<serverRoot>/data/demo`: the folder is fixed here, not taken
 * from the environment, and it makes no network calls.
 */
export function writeSeed(serverRoot: string, now = Date.now()): SeedResult {
  const dataRoot = resolve(serverRoot, "data");
  const dir = resolve(dataRoot, "demo");
  if (!dir.startsWith(dataRoot + sep)) throw new Error(`Refusing to write outside ${dataRoot}`);
  mkdirSync(dir, { recursive: true });

  const candles = generateCandles(now);
  const signals = generateSignals(candles);
  const file: DemoFile = { generatedAt: now, candles };

  const candleFile = join(dir, "candles.json");
  const signalFile = join(dir, "signals.json");
  for (const [path, body] of [
    [candleFile, JSON.stringify(file)],
    [signalFile, JSON.stringify(signals, null, 2)],
  ] as const) {
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
  }
  const candleCount = SYMBOLS.reduce((n, s) => n + TIMEFRAMES.reduce((m, tf) => m + candles[s][tf].length, 0), 0);
  return {
    dir,
    candleFile,
    signalFile,
    candleCount,
    signalCount: signals.length,
    buy: signals.filter((s) => s.side === "BUY").length,
    sell: signals.filter((s) => s.side === "SELL").length,
  };
}

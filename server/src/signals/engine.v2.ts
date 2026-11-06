import { randomUUID } from "node:crypto";
import { classicPivots, PRICE_DECIMALS } from "../analysis/pivots.js";
import type { Symbol } from "../config/symbols.js";
import type { Candle, PivotLevels, Signal, SignalMode, SignalSide } from "../types/index.js";
import { adx, atr, ema, macd, rsi, volumeRatio } from "./indicators.js";
import { computeLevels } from "./levels.js";
import { alignIndices, DAY_MS, H4_MS, HOUR_MS, type MtfSeries } from "./mtf.js";
import { NO_NEWS, type NewsEvaluation } from "./newsFilter.js";
import { assessReversal, type ReversalConfig, type ReversalInput } from "./reversal.js";

export interface EngineConfig {
  /** A signal fires only when its score is at least this (0 to 100). */
  minScore: number;
  minRiskPercent: number;
  maxRiskPercent: number;
  mode: SignalMode;
  /** Reversal candle patterns add up to 15 points at a key level. Absent = off. */
  reversal?: ReversalConfig;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = { minScore: 70, minRiskPercent: 0.4, maxRiskPercent: 4.0, mode: "paper" };

/** The numbers the score is built from, for one candidate side at one 1H candle. */
export interface ScoreFacts {
  price: number;
  // 4H setup
  ema20h4: number;
  ema50h4: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  atrH4: number;
  /** S1 for a BUY, R1 for a SELL. */
  nearLevel: number;
  // 1H trigger
  rsi: number;
  rsiPrev: number;
  histPrev: number;
  hist: number;
  close: number;
  ema20h1: number;
  volRatio: number;
}

export interface Score {
  total: number;
  /** One plain-English line per rule that passed. */
  reasons: string[];
}

export const meetsMinScore = (score: number, minScore: number): boolean => score >= minScore;

const f = (n: number, d = 1) => n.toFixed(d);

/** Setup (4H) is worth 40 points, trigger (1H) 60 points. */
export function scoreSide(side: SignalSide, x: ScoreFacts): Score {
  const buy = side === "BUY";
  const reasons: string[] = [];
  let total = 0;
  const add = (points: number, text: string) => {
    total += points;
    reasons.push(text);
  };

  // ---- setup, 4H: 40 points
  if (buy ? x.ema20h4 > x.ema50h4 : x.ema20h4 < x.ema50h4) add(15, `4H EMA20 ${buy ? "above" : "below"} EMA50`);
  if (x.adx >= 20 && (buy ? x.plusDi > x.minusDi : x.minusDi > x.plusDi)) {
    add(15, `4H ADX ${f(x.adx)} with ${buy ? "+DI above -DI" : "-DI above +DI"}`);
  }
  const nearEma = Math.abs(x.price - x.ema20h4) <= x.atrH4;
  const nearLevel = Math.abs(x.price - x.nearLevel) <= x.atrH4;
  if (nearEma || nearLevel) add(10, `Price within 1 ATR of ${nearEma ? "4H EMA20" : buy ? "support S1" : "resistance R1"}`);

  // ---- trigger, 1H: 60 points
  const rsiOk = buy ? x.rsi > x.rsiPrev && x.rsi >= 35 && x.rsi <= 50 : x.rsi < x.rsiPrev && x.rsi >= 50 && x.rsi <= 65;
  if (rsiOk) add(15, `1H RSI ${f(x.rsi)} ${buy ? "rising from the low zone" : "falling from the high zone"}`);
  if (buy ? x.histPrev <= 0 && x.hist > 0 : x.histPrev >= 0 && x.hist < 0) add(20, `1H MACD histogram crossed ${buy ? "above" : "below"} 0`);
  if (buy ? x.close > x.ema20h1 : x.close < x.ema20h1) add(10, `1H close ${buy ? "above" : "below"} EMA20`);
  if (x.volRatio >= 1.2) add(15, `Volume ${f(x.volRatio, 2)}x its 20-candle average`);

  return { total, reasons };
}

/** Everything computed once per symbol, so a backtest can walk through thousands of candles quickly. */
export interface EngineContext {
  symbol: Symbol;
  series: MtfSeries;
  /** Index of the newest closed 4H / 1D candle for each 1H candle (no lookahead). */
  align4: number[];
  alignD: number[];
  ema200d: number[];
  ema20h4: number[];
  ema50h4: number[];
  ema200h4: number[];
  ema50h1: number[];
  ema200h1: number[];
  volRatio4: number[];
  adx4: ReturnType<typeof adx>;
  atr4: number[];
  ema20h1: number[];
  rsi1: number[];
  hist1: number[];
  volRatio1: number[];
  atr1: number[];
}

export function prepareContext(symbol: Symbol, series: MtfSeries): EngineContext {
  const { h1, h4, d1 } = series;
  const closes1 = h1.map((c) => c.close);
  return {
    symbol,
    series,
    align4: alignIndices(h1, HOUR_MS, h4, H4_MS),
    alignD: alignIndices(h1, HOUR_MS, d1, DAY_MS),
    ema200d: ema(d1.map((c) => c.close), 200),
    ema20h4: ema(h4.map((c) => c.close), 20),
    ema50h4: ema(h4.map((c) => c.close), 50),
    ema200h4: ema(h4.map((c) => c.close), 200),
    ema50h1: ema(closes1, 50),
    ema200h1: ema(closes1, 200),
    volRatio4: volumeRatio(h4.map((c) => c.volume), 20),
    adx4: adx(h4, 14),
    atr4: atr(h4, 14),
    ema20h1: ema(closes1, 20),
    rsi1: rsi(closes1, 14),
    hist1: macd(closes1).histogram,
    volRatio1: volumeRatio(h1.map((c) => c.volume), 20),
    atr1: atr(h1, 14),
  };
}

export interface EvaluateOptions {
  config: EngineConfig;
  /** True when a signal in this direction is already open for the symbol. */
  hasOpen: (symbol: Symbol, side: SignalSide) => boolean;
  idFactory?: () => string;
  /** News for a signal the engine already has. Can add points or block it, never create a signal. Absent = no news. */
  news?: (symbol: Symbol, side: SignalSide) => NewsEvaluation;
}

export type Outcome = { signal: Signal } | { signal: null; reason: string };
const none = (reason: string): Outcome => ({ signal: null, reason });

/** Looks at the closed 1H candle at index `i`. Uses only candles that had closed by then. */
export function evaluateAt(ctx: EngineContext, i: number, opts: EvaluateOptions): Outcome {
  const { series, symbol } = ctx;
  const { config } = opts;
  const candle: Candle | undefined = series.h1[i];
  if (!candle || i < 1) return none("no candle");
  const j4 = ctx.align4[i]!;
  const jd = ctx.alignD[i]!;
  if (j4 < 0 || jd < 0) return none("not enough higher-timeframe history");

  // ---- trend filter (1D, required)
  const day = series.d1[jd]!;
  const ema200 = ctx.ema200d[jd]!;
  if (Number.isNaN(ema200)) return none("1D EMA200 not ready");
  const side: SignalSide | null = day.close > ema200 ? "BUY" : day.close < ema200 ? "SELL" : null;
  if (!side) return none("1D trend is neutral");

  const decimals = PRICE_DECIMALS[symbol];
  const pivots: PivotLevels = classicPivots(day.high, day.low, day.close, decimals);
  const facts: ScoreFacts = {
    price: candle.close,
    ema20h4: ctx.ema20h4[j4]!,
    ema50h4: ctx.ema50h4[j4]!,
    adx: ctx.adx4.adx[j4]!,
    plusDi: ctx.adx4.plusDi[j4]!,
    minusDi: ctx.adx4.minusDi[j4]!,
    atrH4: ctx.atr4[j4]!,
    nearLevel: side === "BUY" ? pivots.S1 : pivots.R1,
    rsi: ctx.rsi1[i]!,
    rsiPrev: ctx.rsi1[i - 1]!,
    histPrev: ctx.hist1[i - 1]!,
    hist: ctx.hist1[i]!,
    close: candle.close,
    ema20h1: ctx.ema20h1[i]!,
    volRatio: ctx.volRatio1[i]!,
  };
  if (Object.values(facts).some((v) => typeof v === "number" && Number.isNaN(v))) return none("indicators not ready");

  const score = scoreSide(side, facts);

  // ---- reversal candle patterns (1H, and the 4H candle if it closed at the same moment): extra points, or a veto
  let reversalVeto: string | null = null;
  if (config.reversal?.enabled) {
    const inputs: ReversalInput[] = [
      { label: "1H", candles: series.h1, i, atr: ctx.atr1[i]!, ema50: ctx.ema50h1[i]!, ema200: ctx.ema200h1[i]!, volRatio: ctx.volRatio1[i]! },
    ];
    const four = series.h4[j4];
    if (four && four.time + H4_MS === candle.time + HOUR_MS) {
      inputs.push({ label: "4H", candles: series.h4, i: j4, atr: ctx.atr4[j4]!, ema50: ctx.ema50h4[j4]!, ema200: ctx.ema200h4[j4]!, volRatio: ctx.volRatio4[j4]! });
    }
    const reversal = assessReversal(side, inputs, pivots, config.reversal);
    reversalVeto = reversal.veto;
    score.total = Math.min(100, score.total + reversal.points);
    score.reasons.push(...reversal.reasons);
  }
  if (!meetsMinScore(score.total, config.minScore)) return none(`score ${score.total} is below ${config.minScore}`);

  // ---- news: only for a signal that already passed the score threshold on its own
  const news = opts.news ? opts.news(symbol, side) : NO_NEWS;
  if (news.veto) return none(news.veto);
  if (news.points > 0) {
    score.total = Math.min(100, score.total + news.points);
    score.reasons.push(...news.reasons);
  }

  // ---- veto rules: any one blocks the signal
  const atr1 = ctx.atr1[i]!;
  if (Number.isNaN(atr1)) return none("1H ATR not ready");
  if (reversalVeto) return none(reversalVeto);
  if (side === "BUY" && facts.rsi > 70) return none("veto: RSI above 70");
  if (side === "SELL" && facts.rsi < 30) return none("veto: RSI below 30");
  const opposing = side === "BUY" ? [pivots.R1, pivots.R2, pivots.R3] : [pivots.S1, pivots.S2, pivots.S3];
  if (opposing.some((p) => Math.abs(p - candle.close) <= 0.3 * atr1)) return none("veto: price within 0.3 ATR of an opposing level");
  if (opts.hasOpen(symbol, side)) return none("veto: a signal in this direction is already open");

  // ---- entry, stop and targets
  const recent = series.h1.slice(Math.max(0, i - 4), i + 1);
  const result = computeLevels({
    side,
    entry: candle.close,
    atr: atr1,
    recentLows: recent.map((c) => c.low),
    recentHighs: recent.map((c) => c.high),
    pivots,
    decimals,
    minRiskPercent: config.minRiskPercent,
    maxRiskPercent: config.maxRiskPercent,
  });
  if (!result.ok) return none(`levels rejected: ${result.reason}`);
  const lv = result.levels;

  const reasons = [`1D close ${side === "BUY" ? "above" : "below"} EMA200 (trend filter)`, ...score.reasons];
  const createdAt = candle.time + HOUR_MS;
  const signal: Signal = {
    id: (opts.idFactory ?? randomUUID)(),
    symbol,
    side,
    timeframe: "1h",
    price: lv.entry,
    levels: { S1: pivots.S1, R2: pivots.R2, pivots },
    indicators: { emaFast: round(facts.ema20h4, decimals), emaSlow: round(facts.ema50h4, decimals), rsi: Math.round(facts.rsi * 10) / 10 },
    trigger: "multi_indicator",
    reason: reasons.join("; "),
    createdAt,
    mode: config.mode,
    score: score.total,
    reasons,
    entry: lv.entry,
    sl: lv.sl,
    tp1: lv.tp1,
    tp2: lv.tp2,
    tp3: lv.tp3,
    riskPercent: lv.riskPercent,
    rrTp1: lv.rrTp1,
    rrTp2: lv.rrTp2,
    rrTp3: lv.rrTp3,
    status: "OPEN",
    statusHistory: [{ status: "OPEN", at: createdAt, price: lv.entry, resultR: null }],
    closedAt: null,
    resultR: null,
    lastCheckedCandle: candle.time,
    ...(news.record ? { news: news.record } : {}),
  };
  return { signal };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

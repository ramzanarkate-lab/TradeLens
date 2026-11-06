import { randomUUID } from "node:crypto";
import { PRICE_DECIMALS } from "../analysis/pivots.js";
import type { Symbol, Timeframe } from "../config/symbols.js";
import { TIMEFRAME_MS } from "../market/aggregate.js";
import type { Candle, PivotLevels, Signal, SignalSide, SignalTrigger } from "../types/index.js";
import { ema, rsi } from "./indicators.js";
import type { SignalSettingsProvider } from "./settingsProvider.js";

export interface EvaluateInput {
  symbol: Symbol;
  timeframe: Timeframe;
  /** Candles in ascending order. The last one must be closed, otherwise nothing is emitted. */
  candles: Candle[];
  pivots: PivotLevels;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Default strategy.
 *  BUY : EMA(fast) crosses above EMA(slow) on the closed candle, RSI within [rsiBuyMin, rsiBuyMax],
 *        close >= S1 and close above the previous close.
 *  SELL: EMA(fast) crosses below EMA(slow), or RSI > rsiSellAbove, or close >= R2.
 * SELL is checked first (risk-off wins). Cooldown: no repeat for the same symbol and side within
 * cooldownMinutes, measured between candle close times. Each closed candle is evaluated at most once.
 */
export class SignalEngine {
  private readonly lastEvaluated = new Map<string, number>();
  private readonly lastSignalAt = new Map<string, number>();

  constructor(private readonly settings: SignalSettingsProvider) {}

  evaluate({ symbol, timeframe, candles, pivots }: EvaluateInput): Signal | null {
    const s = this.settings.get();
    if (!s.enabled) return null;

    const last = candles[candles.length - 1];
    if (!last || !last.closed) return null; // never signal on an incomplete candle

    const key = `${symbol}:${timeframe}`;
    if ((this.lastEvaluated.get(key) ?? -Infinity) >= last.time) return null; // already handled this candle
    this.lastEvaluated.set(key, last.time);

    const closed = candles.filter((c) => c.closed);
    const n = closed.length;
    if (n < Math.max(s.emaSlow, s.rsiPeriod) + 1) return null;

    const closes = closed.map((c) => c.close);
    const fastSeries = ema(closes, s.emaFast);
    const slowSeries = ema(closes, s.emaSlow);
    const rsiSeries = rsi(closes, s.rsiPeriod);
    const fast = fastSeries[n - 1]!;
    const slow = slowSeries[n - 1]!;
    const prevFast = fastSeries[n - 2]!;
    const prevSlow = slowSeries[n - 2]!;
    const rsiNow = rsiSeries[n - 1]!;
    if ([fast, slow, prevFast, prevSlow, rsiNow].some(Number.isNaN)) return null;

    const price = last.close;
    const prevClose = closes[n - 2]!;
    const crossUp = prevFast <= prevSlow && fast > slow;
    const crossDown = prevFast >= prevSlow && fast < slow;
    const d = PRICE_DECIMALS[symbol];
    const fmt = (v: number) => v.toFixed(d);

    // SELL conditions, in priority order
    const sell: Array<{ trigger: SignalTrigger; text: string }> = [];
    if (crossDown) sell.push({ trigger: "ema_cross_down", text: `EMA ${s.emaFast} crossed below EMA ${s.emaSlow}` });
    if (rsiNow > s.rsiSellAbove) sell.push({ trigger: "rsi_overbought", text: `RSI ${rsiNow.toFixed(1)} is above ${s.rsiSellAbove}` });
    if (price >= pivots.R2) sell.push({ trigger: "r2_reached", text: `price ${fmt(price)} reached resistance R2 ${fmt(pivots.R2)}` });

    let side: SignalSide;
    let trigger: SignalTrigger;
    let reason: string;
    if (sell.length > 0) {
      side = "SELL";
      trigger = sell[0]!.trigger;
      reason = `Sell: ${sell.map((x) => x.text).join("; ")} on the closed ${timeframe} candle.`;
    } else if (crossUp && rsiNow >= s.rsiBuyMin && rsiNow <= s.rsiBuyMax && price >= pivots.S1 && price > prevClose) {
      side = "BUY";
      trigger = "ema_cross_up";
      reason =
        `Buy: EMA ${s.emaFast} crossed above EMA ${s.emaSlow} on the closed ${timeframe} candle, ` +
        `RSI ${rsiNow.toFixed(1)} is within ${s.rsiBuyMin}-${s.rsiBuyMax}, ` +
        `and price ${fmt(price)} is above support S1 ${fmt(pivots.S1)} and rising (previous close ${fmt(prevClose)}).`;
    } else {
      return null;
    }

    const createdAt = last.time + TIMEFRAME_MS[timeframe];
    const cooldownKey = `${symbol}:${side}`;
    const previous = this.lastSignalAt.get(cooldownKey);
    if (previous !== undefined && createdAt - previous < s.cooldownMinutes * 60_000) return null;
    this.lastSignalAt.set(cooldownKey, createdAt);

    return {
      id: randomUUID(),
      symbol,
      side,
      timeframe,
      price,
      levels: { S1: pivots.S1, R2: pivots.R2, pivots },
      indicators: { emaFast: round4(fast), emaSlow: round4(slow), rsi: round4(rsiNow) },
      trigger,
      reason,
      createdAt,
    };
  }
}

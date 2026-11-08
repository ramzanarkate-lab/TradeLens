import type { Symbol } from "../config/symbols.js";
import type { MarketService } from "../market/service.js";
import type { Candle } from "../types/index.js";

export const HOUR_MS = 3_600_000;
export const H4_MS = 4 * HOUR_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Candles of the three timeframes, closed candles only, oldest first. */
export interface MtfSeries {
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

/** Candle sizes the engine can use as its TRIGGER series (the entry timing). Setup stays on 4H and the trend on 1D. */
export const TRIGGER_TIMEFRAMES = ["15m", "1h", "4h"] as const;
export type TriggerTimeframe = (typeof TRIGGER_TIMEFRAMES)[number];
export const TRIGGER_MS: Record<TriggerTimeframe, number> = { "15m": 15 * 60_000, "1h": HOUR_MS, "4h": H4_MS };
export const TRIGGER_LABEL: Record<TriggerTimeframe, string> = { "15m": "15m", "1h": "1H", "4h": "4H" };

export function isTriggerTimeframe(value: string): value is TriggerTimeframe {
  return (TRIGGER_TIMEFRAMES as readonly string[]).includes(value);
}

export const closedOnly = (candles: Candle[]): Candle[] => candles.filter((c) => c.closed);

/**
 * For every candle of the lower series, the index of the newest higher-timeframe candle that had ALREADY CLOSED
 * when the lower candle closed (-1 if none). Using that candle and nothing newer means no lookahead.
 */
export function alignIndices(lower: Candle[], lowerMs: number, higher: Candle[], higherMs: number): number[] {
  const out = new Array<number>(lower.length).fill(-1);
  let j = -1;
  for (let i = 0; i < lower.length; i++) {
    const lowerClose = lower[i]!.time + lowerMs;
    while (j + 1 < higher.length && higher[j + 1]!.time + higherMs <= lowerClose) j++;
    out[i] = j;
  }
  return out;
}

export const CANDLES_NEEDED = { h1: 300, h4: 300, d1: 400 } as const;

/**
 * Loads fresh trigger, 4H and 1D candles for a symbol from the market provider and keeps only the closed ones.
 * `h1` holds the TRIGGER candles: 1H by default, 15m or 4H when a different trigger timeframe is chosen.
 */
export async function loadMtf(market: Pick<MarketService, "getFreshCandles">, symbol: Symbol, trigger: TriggerTimeframe = "1h"): Promise<MtfSeries> {
  const [t, h4, d1] = await Promise.all([
    trigger === "4h" ? Promise.resolve(null) : market.getFreshCandles(symbol, trigger, CANDLES_NEEDED.h1),
    market.getFreshCandles(symbol, "4h", CANDLES_NEEDED.h4),
    market.getFreshCandles(symbol, "1d", CANDLES_NEEDED.d1),
  ]);
  const closed4 = closedOnly(h4);
  return { h1: t === null ? closed4 : closedOnly(t), h4: closed4, d1: closedOnly(d1) };
}

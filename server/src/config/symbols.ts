import { z } from "zod";

/** The only symbols the server will serve. Anything else is rejected. */
export const SYMBOLS = ["BTCUSDT", "SOLUSDT", "ETHUSDT"] as const;
export type Symbol = (typeof SYMBOLS)[number];

export const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Intervals the market layer handles internally: the public timeframes plus the 1m live feed. */
export type KlineInterval = Timeframe | "1m";

export const symbolSchema = z.enum(SYMBOLS);
export const timeframeSchema = z.enum(TIMEFRAMES);

export function isSymbol(value: unknown): value is Symbol {
  return symbolSchema.safeParse(value).success;
}

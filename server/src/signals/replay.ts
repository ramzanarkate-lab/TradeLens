import { computePivots } from "../analysis/pivots.js";
import type { SignalSettings } from "../config/signalDefaults.js";
import type { Symbol } from "../config/symbols.js";
import { TIMEFRAME_MS } from "../market/aggregate.js";
import type { Candle, Signal } from "../types/index.js";
import { SignalEngine } from "./engine.js";
import { StaticSignalSettings } from "./settingsProvider.js";

const DAY = TIMEFRAME_MS["1d"];

/**
 * Runs closed candles through a fresh engine one at a time, exactly as the live runner would.
 * `daily` supplies the pivots: at each candle the newest daily candle that had completed by then is used.
 */
export function replaySignals(opts: {
  symbol: Symbol;
  candles: Candle[];
  daily: Candle[];
  settings: SignalSettings;
}): Signal[] {
  const { symbol, candles, daily, settings } = opts;
  const engine = new SignalEngine(new StaticSignalSettings(settings));
  const tfMs = TIMEFRAME_MS[settings.timeframe];
  const out: Signal[] = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    if (!candle.closed) continue;
    const closeTime = candle.time + tfMs;
    const completedDays = daily.filter((d) => d.time + DAY <= closeTime).map((d) => ({ ...d, closed: true }));
    const pivots = computePivots(symbol, completedDays);
    if (!pivots) continue;
    const signal = engine.evaluate({ symbol, timeframe: settings.timeframe, candles: candles.slice(0, i + 1), pivots });
    if (signal) out.push(signal);
  }
  return out;
}

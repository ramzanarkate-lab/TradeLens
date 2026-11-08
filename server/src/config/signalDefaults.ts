import type { TriggerTimeframe } from "../signals/mtf.js";
import { SYMBOLS, type Symbol, type Timeframe } from "./symbols.js";

/** Tunable parameters of the signal strategy, as the engine sees them. Values come from the settings store. */
export interface SignalSettings {
  enabled: boolean;
  /** Candle size that triggers entries: 15m, 1h or 4h (setup stays on 4H and the trend on 1D). */
  triggerTimeframe: TriggerTimeframe;
  /** Symbols the live runner evaluates. */
  enabledSymbols: Symbol[];
  /** Candle timeframe the engine runs on. */
  timeframe: Timeframe;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiBuyMin: number;
  rsiBuyMax: number;
  rsiSellAbove: number;
  /** No repeat signal for the same symbol and side within this many minutes. */
  cooldownMinutes: number;
  minScore: number;
  minRiskPercent: number;
  maxRiskPercent: number;
  stopBufferAtr: number;
  timeStopHours: number;
  mode: "paper" | "live";
  backtestMinProfitFactor: number;
  backtestMinTrades: number;
  backtestMaxDrawdownR: number;
  reversalEnabled: boolean;
  reversalMinVolumeRatio: number;
  reversalLevelToleranceAtr: number;
  reversalPatterns: { hammer: boolean; engulfing: boolean; piercing: boolean; morningStar: boolean; tweezer: boolean };
  telegramPostPaper: boolean;
  newsEnabled: boolean;
  newsWindowMinutes: number;
  newsBoostPoints: number;
  newsVetoEnabled: boolean;
}

export const DEFAULT_SIGNAL_SETTINGS: Readonly<SignalSettings> = Object.freeze({
  enabled: true,
  triggerTimeframe: "15m",
  enabledSymbols: [...SYMBOLS],
  timeframe: "1h",
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  rsiBuyMin: 40,
  rsiBuyMax: 65,
  rsiSellAbove: 75,
  cooldownMinutes: 60,
  minScore: 70,
  minRiskPercent: 0.4,
  maxRiskPercent: 4.0,
  stopBufferAtr: 0.5,
  timeStopHours: 48,
  mode: "paper",
  backtestMinProfitFactor: 1.3,
  backtestMinTrades: 30,
  backtestMaxDrawdownR: 10,
  reversalEnabled: true,
  reversalMinVolumeRatio: 1.2,
  reversalLevelToleranceAtr: 0.5,
  reversalPatterns: Object.freeze({ hammer: true, engulfing: true, piercing: true, morningStar: true, tweezer: true }),
  telegramPostPaper: true,
  newsEnabled: true,
  newsWindowMinutes: 60,
  newsBoostPoints: 5,
  newsVetoEnabled: true,
});

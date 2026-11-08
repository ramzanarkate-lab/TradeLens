import { z } from "zod";
import { symbolSchema, timeframeSchema } from "../config/symbols.js";
import type { Settings } from "../types/index.js";
import { PATTERN_KEYS } from "../signals/patterns.js";
import { TRIGGER_TIMEFRAMES } from "../signals/mtf.js";

const rsiBound = z.number().min(1).max(99);

/** Field rules per section. Every object is strict: unknown keys are rejected. */
const bases = {
  signals: z
    .object({
      emaFast: z.number().int().min(2).max(200),
      emaSlow: z.number().int().min(2).max(200),
      rsiPeriod: z.number().int().min(2).max(100),
      rsiBuyMin: rsiBound,
      rsiBuyMax: rsiBound,
      rsiSellAbove: rsiBound,
      cooldownMinutes: z.number().int().min(0).max(10_080),
      timeframe: timeframeSchema,
      /** Candle size that triggers entries (setup stays on 4H, trend on 1D). */
      triggerTimeframe: z.enum(TRIGGER_TIMEFRAMES),
      /** Multi-indicator engine: a signal fires only with a score of at least this (0 to 100). */
      minScore: z.number().int().min(0).max(100),
      /** A signal is rejected if the stop is closer than this to the entry (percent of entry). */
      minRiskPercent: z.number().min(0.05).max(10),
      maxRiskPercent: z.number().min(0.5).max(20),
      /** Stop-loss buffer beyond the swing low/high or pivot, in ATR(14) units. */
      stopBufferAtr: z.number().min(0.1).max(3),
      /** A signal that is still running after this many hours is closed (TIME_EXIT). */
      timeStopHours: z.number().int().min(1).max(720),
      /** New signals are "paper" unless an admin switches to "live" (needs a PASS backtest). */
      mode: z.enum(["paper", "live"]),
      /** Thresholds for the backtest PASS verdict (out-of-sample part). */
      backtestMinProfitFactor: z.number().min(0.1).max(20),
      backtestMinTrades: z.number().int().min(1).max(100_000),
      backtestMaxDrawdownR: z.number().min(0.5).max(1000),
      /** Reversal candle patterns at key levels add points (see src/signals/patterns.ts). */
      reversalEnabled: z.boolean(),
      reversalMinVolumeRatio: z.number().min(0.5).max(10),
      reversalLevelToleranceAtr: z.number().min(0.1).max(3),
      /** One switch per pattern family (the bearish mirror follows its bullish pattern). */
      reversalPatterns: z.object(Object.fromEntries(PATTERN_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof PATTERN_KEYS)[number], z.ZodBoolean>).strict(),
      /** Admin only: also post paper-mode signals to Telegram, clearly labelled as unverified. Live signals are always posted. */
      telegramPostPaper: z.boolean(),
      /** News filter kill switch. false = news has no effect at all. */
      newsEnabled: z.boolean(),
      /** Only headlines published this many minutes ago or less are used. */
      newsWindowMinutes: z.number().int().min(5).max(1440),
      /** Points added when the net news score agrees with the signal. */
      newsBoostPoints: z.number().int().min(0).max(20),
      /** Strongly opposing news blocks the signal. */
      newsVetoEnabled: z.boolean(),
    })
    .strict(),
  symbols: z
    .object({
      enabled: z
        .array(symbolSchema)
        .min(1, "enable at least one symbol")
        .refine((list) => new Set(list).size === list.length, "symbols must not repeat"),
    })
    .strict(),
  chart: z
    .object({
      defaultSymbol: symbolSchema,
      defaultTimeframe: timeframeSchema,
      showPivots: z.boolean(),
      showVolume: z.boolean(),
      showEma: z.boolean(),
    })
    .strict(),
  alerts: z
    .object({
      sound: z.boolean(),
      vibration: z.boolean(),
      popup: z.boolean(),
      backgroundService: z.boolean(),
    })
    .strict(),
  general: z.object({ language: z.literal("en"), theme: z.enum(["dark", "light", "system"]) }).strict(),
};

export type SectionName = keyof typeof bases;
export const SECTION_NAMES = Object.keys(bases) as SectionName[];

/** Full-section schemas, including rules that compare fields. */
export const sectionSchemas = {
  ...bases,
  signals: bases.signals.superRefine((s, ctx) => {
    if (s.emaFast >= s.emaSlow) {
      ctx.addIssue({ code: "custom", path: ["emaFast"], message: "emaFast must be less than emaSlow" });
    }
    if (s.minRiskPercent >= s.maxRiskPercent) {
      ctx.addIssue({ code: "custom", path: ["minRiskPercent"], message: "minRiskPercent must be less than maxRiskPercent" });
    }
    if (s.rsiBuyMin >= s.rsiBuyMax) {
      ctx.addIssue({ code: "custom", path: ["rsiBuyMin"], message: "rsiBuyMin must be less than rsiBuyMax" });
    }
  }),
};

/** Partial-update schemas: every field optional, still strict. The merged result is re-validated with sectionSchemas. */
export const patchSchemas: Record<SectionName, z.ZodType> = {
  signals: bases.signals.partial().strict(),
  symbols: bases.symbols.partial().strict(),
  chart: bases.chart.partial().strict(),
  alerts: bases.alerts.partial().strict(),
  general: bases.general.partial().strict(),
};

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  signals: {
    emaFast: 20,
    emaSlow: 50,
    rsiPeriod: 14,
    rsiBuyMin: 40,
    rsiBuyMax: 65,
    rsiSellAbove: 75,
    cooldownMinutes: 60,
    timeframe: "1h",
    triggerTimeframe: "15m",
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
    reversalPatterns: { hammer: true, engulfing: true, piercing: true, morningStar: true, tweezer: true },
    telegramPostPaper: true,
    newsEnabled: true,
    newsWindowMinutes: 60,
    newsBoostPoints: 5,
    newsVetoEnabled: true,
  },
  symbols: { enabled: ["BTCUSDT", "SOLUSDT", "ETHUSDT"] },
  chart: { defaultSymbol: "BTCUSDT", defaultTimeframe: "1h", showPivots: true, showVolume: true, showEma: true },
  alerts: { sound: true, vibration: true, popup: true, backgroundService: true },
  general: { language: "en", theme: "dark" },
} satisfies Settings);

/** Formats zod issues as "path: message; ..." for error responses. */
export function describeIssues(error: z.ZodError, prefix: string): string {
  return error.issues.map((i) => `${[prefix, ...i.path].join(".")}: ${i.message}`).join("; ");
}

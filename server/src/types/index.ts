import type { Symbol, Timeframe } from "../config/symbols.js";

export type { Symbol, Timeframe };

/** "pro" is reserved for a future paid tier; nothing assigns it yet. */
export type Role = "user" | "pro" | "admin";

export interface User {
  id: string;
  email: string;
  name: string;
  /** Computed on every request: admin (ADMIN_USER_IDS) > pro (flag) > user. Guests have no User at all. */
  role: Role;
  /** True for pro users and for admins (who have everything a pro has). */
  pro: boolean;
}

/** One OHLCV candle. `time` is the open time in epoch milliseconds; prices are plain numbers. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** false while the candle is still forming */
  closed: boolean;
}

export interface PivotLevels {
  P: number;
  R1: number;
  R2: number;
  R3: number;
  S1: number;
  S2: number;
  S3: number;
}

export type SignalSide = "BUY" | "SELL";
/** What fired the signal. A SELL can have several reasons; `trigger` is the first in this priority order. */
export type SignalTrigger = "ema_cross_up" | "ema_cross_down" | "rsi_overbought" | "r2_reached" | "multi_indicator";

/** OPEN until TP1; TP1_HIT and TP2_HIT are still running (stop moved to entry); the rest are closed. */
export type SignalStatus = "OPEN" | "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "SL_HIT" | "BREAKEVEN_EXIT" | "TIME_EXIT";
export type SignalMode = "paper" | "live";

export interface StatusChange {
  status: SignalStatus;
  /** Epoch ms: candle close time (or the time of the live price). */
  at: number;
  /** Price the change happened at (the level that was hit, or the close for a time exit). */
  price: number;
  /** R-multiple at this change: +1.0 at TP1, -1.0 at the stop, 0 at breakeven. Null for OPEN. */
  resultR: number | null;
}

export interface Signal {
  id: string;
  symbol: Symbol;
  side: SignalSide;
  timeframe: Timeframe;
  /** Close of the candle that produced the signal. */
  price: number;
  /** Pivot levels in force when the signal fired. */
  levels: { S1: number; R2: number; pivots: PivotLevels };
  indicators: { emaFast: number; emaSlow: number; rsi: number };
  trigger: SignalTrigger;
  /** Plain-English explanation. */
  reason: string;
  /** Close time (epoch ms) of the candle that produced the signal. */
  createdAt: number;
  /** True for signals made by POST /api/alerts/test. They are broadcast but never stored. */
  test?: boolean;

  // ---- multi-indicator engine (all optional so older stored signals still load) ----
  mode?: SignalMode;
  /** 0 to 100. */
  score?: number;
  /** One line of plain English per rule that passed. */
  reasons?: string[];
  entry?: number;
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  /** Distance from entry to the stop, in percent of entry. */
  riskPercent?: number;
  /** Reward-to-risk of each target. */
  rrTp1?: number;
  rrTp2?: number;
  rrTp3?: number;
  status?: SignalStatus;
  statusHistory?: StatusChange[];
  closedAt?: number | null;
  /** Final R-multiple once closed (null while running). */
  resultR?: number | null;
  /** Open time of the newest 1H candle the lifecycle tracker has looked at. */
  lastCheckedCandle?: number;
  /** Set when news headlines boosted this signal: the headlines used, their scores, and the decision. */
  news?: SignalNews;
}

/** What news did to a signal. Headlines only (never article text). */
export interface SignalNews {
  decision: "boost" | "veto";
  netScore: number;
  points: number;
  headlines: Array<{ headline: string; source: string; score: number; minutesAgo: number }>;
}

/** Non-secret server settings, stored in data/settings.json. See src/settings/schema.ts for the rules. */
export interface Settings {
  signals: {
    emaFast: number;
    emaSlow: number;
    rsiPeriod: number;
    rsiBuyMin: number;
    rsiBuyMax: number;
    rsiSellAbove: number;
    cooldownMinutes: number;
    timeframe: Timeframe;
    minScore: number;
    minRiskPercent: number;
    maxRiskPercent: number;
    timeStopHours: number;
    mode: SignalMode;
    backtestMinProfitFactor: number;
    backtestMinTrades: number;
    backtestMaxDrawdownR: number;
    reversalEnabled: boolean;
    reversalMinVolumeRatio: number;
    reversalLevelToleranceAtr: number;
    reversalPatterns: { hammer: boolean; engulfing: boolean; piercing: boolean; morningStar: boolean; tweezer: boolean };
    newsEnabled: boolean;
    newsWindowMinutes: number;
    newsBoostPoints: number;
    newsVetoEnabled: boolean;
  };
  symbols: { enabled: Symbol[] };
  chart: {
    defaultSymbol: Symbol;
    defaultTimeframe: Timeframe;
    showPivots: boolean;
    showVolume: boolean;
    showEma: boolean;
  };
  alerts: { sound: boolean; vibration: boolean; popup: boolean; backgroundService: boolean };
  /** The app is English only; `language` is kept for the settings contract and can only be "en". */
  general: { language: "en"; theme: "dark" | "light" | "system" };
}

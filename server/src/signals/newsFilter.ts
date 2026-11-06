import type { SignalNews, SignalSide } from "../types/index.js";

export interface NewsSettings {
  enabled: boolean;
  windowMinutes: number;
  boostPoints: number;
  vetoEnabled: boolean;
}

/** A headline already matched to a symbol and scored. `score` includes the weight (0.5 for a market-wide headline). */
export interface ScoredHeadline {
  headline: string;
  source: string;
  publishedAt: number;
  score: number;
}

export interface NewsEvaluation {
  points: number;
  /** Set when news blocks the signal: "Negative news (SEC lawsuit, 12 min ago) blocked this BUY". */
  veto: string | null;
  /** Saved with the signal when news boosted it. Null when news changed nothing. */
  record: SignalNews | null;
  /** Reason lines for the signal, e.g. "Positive news (ETF inflow, 8 min ago) added 5 points". */
  reasons: string[];
  /** Kept for the log even when the signal is blocked and never stored. */
  logRecord: SignalNews | null;
}

export const NO_NEWS: NewsEvaluation = { points: 0, veto: null, record: null, reasons: [], logRecord: null };
export const NET_CLAMP = 5;
const BOOST_AT = 2;
const VETO_AT = 3;

const short = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}...` : s);
const ago = (now: number, t: number) => Math.max(0, Math.round((now - t) / 60_000));

/**
 * Turns the headlines of the last hour into a decision for one signal that the engine ALREADY has.
 * Net score = sum of the headline scores, clamped to -5..+5.
 * BUY: net >= +2 adds points, net <= -3 blocks. SELL: net <= -2 adds points, net >= +3 blocks.
 */
export function evaluateNews(side: SignalSide, headlines: ScoredHeadline[], settings: NewsSettings, now: number): NewsEvaluation {
  if (!settings.enabled) return NO_NEWS;
  const used = headlines.filter((h) => h.score !== 0 && now - h.publishedAt <= settings.windowMinutes * 60_000 && h.publishedAt <= now + 5 * 60_000);
  if (used.length === 0) return NO_NEWS;
  const net = Math.max(-NET_CLAMP, Math.min(NET_CLAMP, used.reduce((sum, h) => sum + h.score, 0)));
  const supports = side === "BUY" ? net : -net; // positive = news agrees with the signal
  const list = used.map((h) => ({ headline: h.headline, source: h.source, score: h.score, minutesAgo: ago(now, h.publishedAt) }));
  // The headline that agrees most (best) or disagrees most (worst) with the signal names the reason.
  const agree = (h: { score: number }) => (side === "BUY" ? h.score : -h.score);
  const best = list.reduce((x, y) => (agree(y) > agree(x) ? y : x));
  const worst = list.reduce((x, y) => (agree(y) < agree(x) ? y : x));

  if (supports <= -VETO_AT && settings.vetoEnabled) {
    const word = net < 0 ? "Negative" : "Positive";
    const logRecord: SignalNews = { decision: "veto", netScore: net, points: 0, headlines: list };
    return { points: 0, veto: `${word} news (${short(worst.headline)}, ${worst.minutesAgo} min ago) blocked this ${side}`, record: null, reasons: [], logRecord };
  }
  if (supports >= BOOST_AT && settings.boostPoints > 0) {
    const word = net > 0 ? "Positive" : "Negative";
    const record: SignalNews = { decision: "boost", netScore: net, points: settings.boostPoints, headlines: list };
    return { points: settings.boostPoints, veto: null, record, reasons: [`${word} news (${short(best.headline)}, ${best.minutesAgo} min ago) added ${settings.boostPoints} points`], logRecord: record };
  }
  return NO_NEWS;
}

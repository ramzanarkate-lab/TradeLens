import type { Symbol } from "../config/symbols.js";
import { SYMBOLS } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import { evaluateNews, NO_NEWS, type NewsEvaluation, type NewsSettings, type ScoredHeadline } from "../signals/newsFilter.js";
import type { SignalSide } from "../types/index.js";
import { matchSymbols, weightFor, type SymbolMatch } from "./match.js";
import type { NewsScorer } from "./sentiment.js";
import type { NewsFetcher, NewsItem } from "./sources.js";

export const STALE_AFTER_MS = 30 * 60_000;

export interface ScoredItem extends NewsItem {
  /** Raw score of the headline, -3..+3. */
  score: number;
  symbols: Symbol[];
  marketWide: boolean;
}

export interface NewsServiceOptions {
  fetcher: Pick<NewsFetcher, "all" | "feedStatus" | "lastSuccessAt" | "startedAt">;
  scorer: NewsScorer;
  logger: Logger;
  now?: () => number;
}

/** Joins the feeds, the symbol matcher and the scorer, and answers: what does news say about this symbol right now? */
export class NewsService {
  private readonly now: () => number;
  private readonly staleLogged = new Set<string>();

  constructor(private readonly o: NewsServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  /** "stale" once no feed has answered for 30 minutes: the filter is then off. */
  feedHealth(): "ok" | "stale" {
    const last = this.o.fetcher.lastSuccessAt() ?? this.o.fetcher.startedAt;
    return this.now() - last > STALE_AFTER_MS ? "stale" : "ok";
  }

  private scored(item: NewsItem): ScoredItem {
    const match: SymbolMatch = matchSymbols(item.headline);
    return { ...item, score: this.o.scorer.score(item.headline), symbols: match.symbols, marketWide: match.marketWide };
  }

  /** Headlines for a symbol, newest first, scored. */
  recent(symbol: Symbol | undefined, limit: number): ScoredItem[] {
    const out: ScoredItem[] = [];
    for (const item of this.o.fetcher.all()) {
      const s = this.scored(item);
      if (symbol ? s.symbols.includes(symbol) : s.symbols.length > 0) out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Headlines inside the window with the market-wide half weight applied. */
  headlinesFor(symbol: Symbol, windowMinutes: number): ScoredHeadline[] {
    const now = this.now();
    const out: ScoredHeadline[] = [];
    for (const item of this.o.fetcher.all()) {
      if (now - item.publishedAt > windowMinutes * 60_000) break; // newest first: the rest are older
      const match = matchSymbols(item.headline);
      const weight = weightFor(symbol, match);
      if (weight === 0) continue;
      out.push({ headline: item.headline, source: item.source, publishedAt: item.publishedAt, score: this.o.scorer.score(item.headline) * weight });
    }
    return out;
  }

  /**
   * The news decision for a signal the engine already has. Off when the kill switch is off, and off for this symbol
   * (with one log line) when the feeds have been silent for 30 minutes.
   */
  evaluate(symbol: Symbol, side: SignalSide, settings: NewsSettings): NewsEvaluation {
    if (!settings.enabled) return NO_NEWS;
    if (this.feedHealth() === "stale") {
      if (!this.staleLogged.has(symbol)) {
        this.staleLogged.add(symbol);
        this.o.logger.warn({ symbol }, "news filter is OFF for this symbol: no news feed has answered for 30 minutes");
      }
      return NO_NEWS;
    }
    this.staleLogged.clear();
    const result = evaluateNews(side, this.headlinesFor(symbol, settings.windowMinutes), settings, this.now());
    if (result.logRecord) {
      this.o.logger.info(
        { symbol, side, decision: result.logRecord.decision, netScore: result.logRecord.netScore, headlines: result.logRecord.headlines.map((h) => ({ headline: h.headline, score: h.score })) },
        "news decision",
      );
    }
    return result;
  }

  /** For /health: "off" when disabled, "stale" when the feeds went quiet, otherwise "ok". */
  healthStatus(enabled: boolean): "ok" | "stale" | "off" {
    if (!enabled) return "off";
    return this.feedHealth();
  }

  symbols(): readonly Symbol[] {
    return SYMBOLS;
  }
}

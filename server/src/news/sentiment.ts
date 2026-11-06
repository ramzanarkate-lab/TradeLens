import { readFileSync } from "node:fs";

/** Anything that can turn a headline into a number from -3 (very bearish) to +3 (very bullish). Swap in an AI model later. */
export interface NewsScorer {
  score(headline: string): number;
}

export interface KeywordConfig {
  bullish: string[];
  bearish: string[];
  negations: string[];
}

export const MAX_HEADLINE_SCORE = 3;
const NEGATION_WINDOW_WORDS = 3;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];

export function loadKeywords(file: URL | string): KeywordConfig {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<KeywordConfig>;
  return { bullish: raw.bullish ?? [], bearish: raw.bearish ?? [], negations: raw.negations ?? ["not", "no", "fails to"] };
}

/**
 * Rule-based scorer. Each bullish keyword is +1 and each bearish keyword is -1. A bullish keyword with "not", "no" or
 * "fails to" in the 3 words before it counts as bearish (-1). The sum is clamped to -3..+3.
 */
export class RuleBasedScorer implements NewsScorer {
  private readonly rules: Array<{ re: RegExp; value: 1 | -1; bullish: boolean }>;
  private readonly negations: string[][];

  constructor(private readonly config: KeywordConfig) {
    const rule = (phrase: string, value: 1 | -1, bullish: boolean) => ({
      re: new RegExp(`(?<![\\p{L}\\p{N}])${phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(escape).join("[\\s-]+")}(?:s|es|ed|ing|ers?)?(?![\\p{L}\\p{N}])`, "giu"),
      value,
      bullish,
    });
    this.rules = [...config.bullish.map((p) => rule(p, 1, true)), ...config.bearish.map((p) => rule(p, -1, false))];
    this.negations = config.negations.map((n) => words(n));
  }

  score(headline: string): number {
    const lower = headline.toLowerCase();
    let total = 0;
    for (const { re, value, bullish } of this.rules) {
      re.lastIndex = 0;
      for (const m of lower.matchAll(re)) {
        total += bullish && this.negated(lower.slice(0, m.index)) ? -1 : value;
      }
    }
    return Math.max(-MAX_HEADLINE_SCORE, Math.min(MAX_HEADLINE_SCORE, total));
  }

  /** Is one of the negation phrases among the last 3 words before the keyword? */
  private negated(before: string): boolean {
    const w = words(before).slice(-NEGATION_WINDOW_WORDS);
    return this.negations.some((n) => {
      if (n.length === 0) return false;
      for (let i = 0; i + n.length <= w.length; i++) if (n.every((x, k) => w[i + k] === x)) return true;
      return false;
    });
  }
}

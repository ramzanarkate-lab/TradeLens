import { SYMBOLS, type Symbol } from "../config/symbols.js";

/** Whole words only: "sol" must not match "solution", "eth" must not match "method". */
const WORDS: Record<Symbol, string[]> = {
  BTCUSDT: ["bitcoin", "btc"],
  SOLUSDT: ["solana", "sol"],
  ETHUSDT: ["ethereum", "eth", "ether"],
};

const PATTERNS = Object.fromEntries(SYMBOLS.map((s) => [s, new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS[s].join("|")})(?![\\p{L}\\p{N}])`, "iu")])) as Record<Symbol, RegExp>;

export interface SymbolMatch {
  symbols: Symbol[];
  /** The headline mentions all three coins: it applies to each of them at half weight. */
  marketWide: boolean;
}

export function matchSymbols(headline: string): SymbolMatch {
  const symbols = SYMBOLS.filter((s) => PATTERNS[s].test(headline));
  return { symbols, marketWide: symbols.length === SYMBOLS.length };
}

/** 1 for a headline about this symbol, 0.5 when it names all three, 0 when it does not name the symbol. */
export function weightFor(symbol: Symbol, match: SymbolMatch): number {
  if (!match.symbols.includes(symbol)) return 0;
  return match.marketWide ? 0.5 : 1;
}

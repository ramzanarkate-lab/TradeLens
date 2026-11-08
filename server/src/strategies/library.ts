import { atr, bollinger, ema, macd, rsi, sma } from "../signals/indicators.js";
import type { Candle } from "../types/index.js";
import type { Plan, Strategy, StrategyContext, StrategyInstance } from "./types.js";

/*
 * The strategy library. The rules are LOCKED: no value here changes after a backtest.
 *
 * Common rules: long only. A signal is evaluated on the close of a candle and the position enters at the OPEN of the next
 * candle (so every rule below describes the SIGNAL, and the stop and target are taken from the actual entry price). Fees 0.1%
 * per side and slippage 0.05% per fill are applied by the backtest engine. If the stop and the target are both reached in
 * the same candle, the stop is assumed to have been hit first.
 *
 * Interpretations that the rules leave open, applied the same way everywhere:
 *  - "N-period average volume" is the average of the N candles BEFORE the signal candle (the candle does not count toward
 *    its own average).
 *  - A rule that closes a position at a candle's close (an RSI level, a moving-average cross, a band) fills at that close.
 *    Price levels (stops and targets) fill at the level; a stop that is gapped through fills at the open.
 *  - Every open position is also closed at market after 24 hours (see engine.ts).
 */

const closesOf = (c: Candle[]) => c.map((x) => x.close);
const volumesOf = (c: Candle[]) => c.map((x) => x.volume);

/** Average of volumes[i-n .. i-1]. */
function avgPriorVolume(volumes: number[], i: number, n: number): number {
  if (i < n) return Number.NaN;
  let sum = 0;
  for (let k = i - n; k < i; k++) sum += volumes[k]!;
  return sum / n;
}

const maxHighPrior = (c: Candle[], i: number, n: number) => Math.max(...c.slice(i - n, i).map((x) => x.high));

/** Supertrend(period, multiplier). Returns +1 (bullish) or -1 (bearish) per candle; 0 before it exists. */
export function supertrend(candles: Candle[], period = 10, multiplier = 3): number[] {
  const a = atr(candles, period);
  const dir = new Array<number>(candles.length).fill(0);
  let finalUpper = Number.NaN;
  let finalLower = Number.NaN;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(a[i]!)) continue;
    const c = candles[i]!;
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * a[i]!;
    const basicLower = hl2 - multiplier * a[i]!;
    const prev = candles[i - 1]!;
    if (Number.isNaN(finalUpper)) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      dir[i] = c.close >= hl2 ? 1 : -1;
      continue;
    }
    const nextUpper = basicUpper < finalUpper || prev.close > finalUpper ? basicUpper : finalUpper;
    const nextLower = basicLower > finalLower || prev.close < finalLower ? basicLower : finalLower;
    dir[i] = c.close > finalUpper ? 1 : c.close < finalLower ? -1 : dir[i - 1]!;
    finalUpper = nextUpper;
    finalLower = nextLower;
  }
  return dir;
}

/** Stablecoins and leveraged tokens are not regular coins. The base asset is the symbol without its USDT quote. */
const STABLECOINS = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "BUSD", "USDP", "USDD", "PYUSD", "EUR", "EURT", "AEUR", "USDE", "GUSD"]);
export function isRegularCoin(symbol: string): boolean {
  const base = symbol.toUpperCase().replace(/(USDT|USDC|BUSD|FDUSD)$/, "");
  if (!base || STABLECOINS.has(base)) return false;
  if (/(UP|DOWN|BULL|BEAR)$/.test(base) && base.length > 4) return false; // leveraged tokens such as BTCUP or ETHBULL
  if (/\d+[LS]$/.test(base)) return false; // 3L, 3S, 5L ...
  return true;
}

/** An instance from an entry condition and the plan that follows it. */
function instance(condition: (i: number) => boolean, plan: (i: number) => Plan): StrategyInstance {
  return { signal: (i) => (condition(i) ? plan(i) : null), plan };
}

const make = (strategy: Omit<Strategy, "kind" | "create"> & { kind?: Strategy["kind"]; create: Strategy["create"] }): Strategy => ({ kind: "standard", ...strategy });

// ---------------------------------------------------------------------------------------------------------------------
// 1. RsiOversoldRebound (4h)
//    Entry: RSI(14) < 30 AND volume > 20-period average volume.
//    Exit: first of RSI(14) > 70, price >= entry +5%, or price <= entry -3%.
// ---------------------------------------------------------------------------------------------------------------------
export const RsiOversoldRebound = make({
  id: "RsiOversoldRebound",
  name: "RSI Oversold Rebound",
  number: 1,
  timeframe: "4h",
  warmup: 21,
  create(candles) {
    const rsi14 = rsi(closesOf(candles), 14);
    const volumes = volumesOf(candles);
    return instance(
      (i) => rsi14[i]! < 30 && candles[i]!.volume > avgPriorVolume(volumes, i, 20),
      () => ({
        levels: (entry) => ({ stopLoss: entry * 0.97, targets: [entry * 1.05] }),
        onClose: (j) => (rsi14[j]! > 70 ? { exit: "RSI(14) > 70" } : null),
      }),
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. MovingAverageScalper (15m)
//    MA: SMA(20). Entry: close crosses above the MA (previous close <= MA, current close > MA) AND close > close 3 bars ago.
//    Exit: close crosses back below the MA, or +2%, or -1%, whichever first.
// ---------------------------------------------------------------------------------------------------------------------
export const MovingAverageScalper = make({
  id: "MovingAverageScalper",
  name: "Moving Average Scalper",
  number: 2,
  timeframe: "15m",
  warmup: 21,
  create(candles) {
    const closes = closesOf(candles);
    const ma = sma(closes, 20);
    return instance(
      (i) => i >= 3 && !Number.isNaN(ma[i - 1]!) && closes[i - 1]! <= ma[i - 1]! && closes[i]! > ma[i]! && closes[i]! > closes[i - 3]!,
      () => ({
        levels: (entry) => ({ stopLoss: entry * 0.99, targets: [entry * 1.02] }),
        // the close crosses back below the MA: the previous close was at or above it, this one is below
        onClose: (j) => (closes[j - 1]! >= ma[j - 1]! && closes[j]! < ma[j]! ? { exit: "close crossed back below SMA(20)" } : null),
      }),
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. VolatilityBreakout (1h)
//    Entry: close > highest high of the previous 24 bars AND volume > 1.5x the 20-bar average volume AND ATR(14) now >
//    ATR(14) 5 bars ago.
//    Exit: trailing stop at (highest close since entry) minus 2x ATR(14). No fixed target.
//    The first stop is the signal candle's close minus 2x ATR(14), the same formula with nothing yet to trail.
// ---------------------------------------------------------------------------------------------------------------------
export const VolatilityBreakout = make({
  id: "VolatilityBreakout",
  name: "Volatility Breakout",
  number: 3,
  timeframe: "1h",
  warmup: 25,
  create(candles) {
    const atr14 = atr(candles, 14);
    const volumes = volumesOf(candles);
    return instance(
      (i) => {
        if (i < 24 || Number.isNaN(atr14[i]!) || Number.isNaN(atr14[i - 5]!)) return false;
        const c = candles[i]!;
        return c.close > maxHighPrior(candles, i, 24) && c.volume > 1.5 * avgPriorVolume(volumes, i, 20) && atr14[i]! > atr14[i - 5]!;
      },
      (i) => {
        const firstStop = candles[i]!.close - 2 * atr14[i]!;
        return {
          levels: () => ({ stopLoss: firstStop, targets: [] }),
          onClose: (j, pos) => {
            let highestClose = -Infinity;
            for (let k = pos.entryIndex; k <= j; k++) highestClose = Math.max(highestClose, candles[k]!.close);
            return { stop: highestClose - 2 * atr14[j]! };
          },
        };
      },
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. DcaAccumulator (1h): see dca.ts. It never creates its own entries; it follows another strategy's buy.
// 6. GridTrading (1h): see grid.ts. It is exempt from the one-position rule (up to 5 open positions).
// ---------------------------------------------------------------------------------------------------------------------
const noEntries = (): StrategyInstance => ({ signal: () => null, plan: () => ({ levels: (entry) => ({ stopLoss: entry, targets: [] }) }) });
export const DcaAccumulator = make({ id: "DcaAccumulator", name: "DCA Accumulator", number: 4, timeframe: "1h", kind: "dca", warmup: 0, create: noEntries });
export const GridTrading = make({ id: "GridTrading", name: "Grid Trading", number: 6, timeframe: "1h", kind: "grid", warmup: 21, create: noEntries });

// ---------------------------------------------------------------------------------------------------------------------
// 5. SupertrendMomentum (4h)
//    Indicator: Supertrend(10, 3).
//    Entry: Supertrend flips from bearish to bullish AND MACD(12, 26, 9) histogram > 0 AND histogram rising (current > previous).
//    Exit: Supertrend flips bearish, OR stop-loss at 3% below entry.
// ---------------------------------------------------------------------------------------------------------------------
export const SupertrendMomentum = make({
  id: "SupertrendMomentum",
  name: "Supertrend Momentum",
  number: 5,
  timeframe: "4h",
  warmup: 40,
  create(candles) {
    const dir = supertrend(candles, 10, 3);
    const hist = macd(closesOf(candles), 12, 26, 9).histogram;
    return instance(
      (i) => i >= 1 && dir[i - 1] === -1 && dir[i] === 1 && hist[i]! > 0 && hist[i]! > hist[i - 1]!,
      () => ({
        levels: (entry) => ({ stopLoss: entry * 0.97, targets: [] }),
        onClose: (j) => (dir[j] === -1 ? { exit: "Supertrend flipped bearish" } : null),
      }),
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. SupportResistanceBounce (4h)
//    Support: lowest swing low in the last 50 bars. A swing low is a pivot whose low is lower than the lows of the 3 bars on
//    each side. A pivot is usable only after 3 bars have closed past it (no look-ahead).
//    Entry: the candle's low is within 0.5% of the support AND the candle is bullish (close > open).
//    Exit: +4% target, or a stop 1% below the support.
// ---------------------------------------------------------------------------------------------------------------------
export function supportAt(candles: Candle[], i: number): number | null {
  let support: number | null = null;
  for (let p = Math.max(3, i - 49); p + 3 <= i; p++) {
    const low = candles[p]!.low;
    let swing = true;
    for (let k = 1; k <= 3 && swing; k++) swing = low < candles[p - k]!.low && low < candles[p + k]!.low;
    if (swing && (support === null || low < support)) support = low;
  }
  return support;
}

export const SupportResistanceBounce = make({
  id: "SupportResistanceBounce",
  name: "Support/Resistance Bounce",
  number: 7,
  timeframe: "4h",
  warmup: 55,
  create(candles) {
    return instance(
      (i) => {
        const support = supportAt(candles, i);
        const c = candles[i]!;
        return support !== null && Math.abs(c.low - support) / support <= 0.005 && c.close > c.open;
      },
      (i) => {
        const support = supportAt(candles, i) ?? candles[i]!.low;
        return { levels: (entry) => ({ stopLoss: support * 0.99, targets: [entry * 1.04] }) };
      },
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. BollingerMeanReversion (1h)
//    Bands: Bollinger(20, 2). Entry: close < lower band AND RSI(14) < 35.
//    Exit: close >= middle band (SMA 20), or close >= upper band, whichever first, OR a stop-loss 3% below entry.
// ---------------------------------------------------------------------------------------------------------------------
export const BollingerMeanReversion = make({
  id: "BollingerMeanReversion",
  name: "Bollinger Mean Reversion",
  number: 8,
  timeframe: "1h",
  warmup: 21,
  create(candles) {
    const closes = closesOf(candles);
    const bb = bollinger(closes, 20, 2);
    const rsi14 = rsi(closes, 14);
    return instance(
      (i) => !Number.isNaN(bb.lower[i]!) && !Number.isNaN(rsi14[i]!) && closes[i]! < bb.lower[i]! && rsi14[i]! < 35,
      () => ({
        levels: (entry) => ({ stopLoss: entry * 0.97, targets: [] }),
        onClose: (j) => (closes[j]! >= bb.middle[j]! || closes[j]! >= bb.upper[j]! ? { exit: "close reached the middle band" } : null),
      }),
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. BreakoutPlusRetest (1h)
//    Breakout: close > highest high of the prior 20 bars AND volume > 1.5x the 20-bar average. That highest high is the
//    broken level.
//    Retest entry: within 10 bars after the breakout, a candle whose low comes within 0.3% of the level and closes above it.
//    Exit: a stop 1% below the level, or a +3% target. Only the first retest of a breakout is traded.
// ---------------------------------------------------------------------------------------------------------------------
export const BreakoutPlusRetest = make({
  id: "BreakoutPlusRetest",
  name: "Breakout Plus Retest",
  number: 9,
  timeframe: "1h",
  warmup: 22,
  create(candles) {
    const volumes = volumesOf(candles);
    /** The broken level if candle b is a breakout, else null. */
    const breakoutLevel = (b: number): number | null => {
      if (b < 20) return null;
      const level = maxHighPrior(candles, b, 20);
      return candles[b]!.close > level && candles[b]!.volume > 1.5 * avgPriorVolume(volumes, b, 20) ? level : null;
    };
    const retests = (k: number, level: number) => Math.abs(candles[k]!.low - level) / level <= 0.003 && candles[k]!.close > level;
    /** The broken level of the most recent breakout in the 10 candles before i, unless it was already retested; else null. */
    const breakoutBefore = (i: number): number | null => {
      for (let b = i - 1; b >= Math.max(20, i - 10); b--) {
        const level = breakoutLevel(b);
        if (level === null) continue;
        for (let k = b + 1; k < i; k++) if (retests(k, level)) return null; // that breakout was already retested
        return level;
      }
      return null;
    };
    return instance(
      (i) => {
        const level = breakoutBefore(i);
        return level !== null && retests(i, level);
      },
      (i) => {
        const level = breakoutBefore(i) ?? candles[i]!.low;
        return { levels: (entry) => ({ stopLoss: level * 0.99, targets: [entry * 1.03] }) };
      },
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. MacdHistogramExpansion (1h)
//     Indicator: MACD(12, 26, 9).
//     Entry: histogram > 0 AND histogram > its value 2 bars ago AND close > EMA(50).
//     Exit: the histogram contracts for 2 consecutive bars, or +4%, or -2%, whichever first.
// ---------------------------------------------------------------------------------------------------------------------
export const MacdHistogramExpansion = make({
  id: "MacdHistogramExpansion",
  name: "MACD Histogram Expansion",
  number: 10,
  timeframe: "1h",
  warmup: 51,
  create(candles) {
    const closes = closesOf(candles);
    const hist = macd(closes, 12, 26, 9).histogram;
    const ema50 = ema(closes, 50);
    return instance(
      (i) => i >= 2 && !Number.isNaN(hist[i - 2]!) && !Number.isNaN(ema50[i]!) && hist[i]! > 0 && hist[i]! > hist[i - 2]! && closes[i]! > ema50[i]!,
      () => ({
        levels: (entry) => ({ stopLoss: entry * 0.98, targets: [entry * 1.04] }),
        onClose: (j) => (j >= 2 && hist[j]! < hist[j - 1]! && hist[j - 1]! < hist[j - 2]! ? { exit: "histogram contracted for 2 bars" } : null),
      }),
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 11. UnusualVolumeGainers (1h), an altFINS-style scan. All filters must be true:
//     volume >= 2x the 10-period average volume; price change over the bar > 0 (close above open); market cap >= $5,000,000
//     (candle data has no market cap field: the filter is skipped and that is logged); regular coins only (no stablecoins or
//     leveraged tokens).
//     Entry: the next candle's open. Exit: a stop 1% below the entry, or +3%, or 6 bars elapsed, whichever first.
// ---------------------------------------------------------------------------------------------------------------------
export const UnusualVolumeGainers = make({
  id: "UnusualVolumeGainers",
  name: "Unusual Volume Gainers",
  number: 11,
  timeframe: "1h",
  warmup: 11,
  create(candles, ctx: StrategyContext) {
    const volumes = volumesOf(candles);
    let loggedMarketCap = false;
    const regular = isRegularCoin(ctx.symbol);
    const plan = (): Plan => ({ levels: (entry) => ({ stopLoss: entry * 0.99, targets: [entry * 1.03] }), maxBars: 6, note: "market cap filter skipped (no data)" });
    return instance((i) => {
      if (!regular) return false;
      const c = candles[i]!;
      const average = avgPriorVolume(volumes, i, 10);
      if (!(average > 0) || c.volume < 2 * average || !(c.close > c.open)) return false;
      if (!loggedMarketCap) {
        ctx.log?.("UnusualVolumeGainers: market cap is not available from the data source, so the $5,000,000 filter is skipped");
        loggedMarketCap = true;
      }
      return true;
    }, plan);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// 12. EmaCrossover12_50 (1h)
//     Entry: EMA(12) crosses above EMA(50). Exit: EMA(12) crosses below EMA(50), or a stop 2% below the entry.
// ---------------------------------------------------------------------------------------------------------------------
export const EmaCrossover12_50 = make({
  id: "EmaCrossover12_50",
  name: "EMA Crossover 12/50",
  number: 12,
  timeframe: "1h",
  warmup: 52,
  create(candles) {
    const closes = closesOf(candles);
    const fast = ema(closes, 12);
    const slow = ema(closes, 50);
    return instance(
      (i) => i >= 1 && !Number.isNaN(slow[i - 1]!) && fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!,
      () => ({
        levels: (entry) => ({ stopLoss: entry * 0.98, targets: [] }),
        onClose: (j) => (j >= 1 && fast[j - 1]! >= slow[j - 1]! && fast[j]! < slow[j]! ? { exit: "EMA(12) crossed below EMA(50)" } : null),
      }),
    );
  },
});

/** The 12 strategies, in the library's order. The list is fixed: nothing is added or changed without a new review. */
export const STRATEGIES: readonly Strategy[] = [
  RsiOversoldRebound,
  MovingAverageScalper,
  VolatilityBreakout,
  DcaAccumulator,
  SupertrendMomentum,
  GridTrading,
  SupportResistanceBounce,
  BollingerMeanReversion,
  BreakoutPlusRetest,
  MacdHistogramExpansion,
  UnusualVolumeGainers,
  EmaCrossover12_50,
];

export function getStrategy(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

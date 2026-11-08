import { DEFAULT_COSTS, type CostModel } from "../backtest/backtest.js";
import type { Candle } from "../types/index.js";
import type { SimulatedTrade } from "./engine.js";

/*
 * 4. DcaAccumulator (1h). It runs ONLY as a follow-up to a buy signal from another strategy and never creates its own entries.
 *   Entry:  25% of the planned position at the trigger (the parent's entry).
 *   Then:   the remaining 75% in 6 equal parts, one per hourly candle (at each candle's open), but only while the price is at
 *           or below the first entry +2%. The first time it is above, the rest is cancelled.
 *   Exit:   the parent strategy's exit rules, applied to the full position.
 *
 * Which parents: the buy signals of the other strategies that run on 1h candles (the six hourly parts need that series).
 * One DCA position is open per symbol at a time; a parent signal that arrives while one is open is not followed.
 */
export const DCA = { firstShare: 0.25, parts: 6, partShare: 0.75 / 6, maxAboveFirstEntryPercent: 2 } as const;

export interface DcaFill {
  time: number;
  price: number;
  /** Share of the planned position. */
  weight: number;
}

/**
 * The fills of a DCA position that follows a parent entered at candle `entryIndex` (at `entryPrice`, its open) and left in
 * candle `exitIndex`. A part is bought at the open of each of the next 6 candles that the position is still open for.
 */
export function dcaFills(candles: Candle[], entryIndex: number, entryPrice: number, exitIndex: number): DcaFill[] {
  const fills: DcaFill[] = [{ time: candles[entryIndex]!.time, price: entryPrice, weight: DCA.firstShare }];
  for (let k = 1; k <= DCA.parts; k++) {
    const j = entryIndex + k;
    if (j > exitIndex || j >= candles.length) break; // the parent already closed
    const c = candles[j]!;
    if (c.open > entryPrice * (1 + DCA.maxAboveFirstEntryPercent / 100)) break; // price ran away: the remainder is cancelled
    fills.push({ time: c.time, price: c.open, weight: DCA.partShare });
  }
  return fills;
}

/** Net result of the whole DCA position in R. R is the parent's risk on the full planned position (entry to its first stop). */
export function dcaNetR(fills: DcaFill[], exitPrice: number, firstStop: number, entryPrice: number, costs: CostModel = DEFAULT_COSTS): number {
  const risk = entryPrice - firstStop; // 1R per planned unit, as for any other trade
  const exitFill = exitPrice * (1 - costs.slippage);
  let pnl = 0;
  for (const f of fills) {
    const entryFill = f.price * (1 + costs.slippage);
    pnl += f.weight * (exitFill - entryFill - costs.feePerSide * (entryFill + exitFill));
  }
  return pnl / risk;
}

/**
 * Backtest of DcaAccumulator on one symbol: it follows the trades of its parents (already simulated on the same hourly
 * candles), oldest first, one position at a time.
 */
export function simulateDca(strategyId: string, candles: Candle[], parentTrades: SimulatedTrade[], costs: CostModel = DEFAULT_COSTS): SimulatedTrade[] {
  const out: SimulatedTrade[] = [];
  let busyUntil = -Infinity;
  for (const parent of [...parentTrades].sort((a, b) => a.createdAt - b.createdAt)) {
    if (parent.entryTime < busyUntil) continue; // one DCA position per symbol
    const fills = dcaFills(candles, parent.entryIndex, parent.entry, parent.exitIndex);
    busyUntil = parent.exitTime;
    out.push({
      ...parent,
      strategyId,
      netR: dcaNetR(fills, parent.exitPrice, parent.stopLoss, parent.entry, costs),
    });
  }
  return out;
}

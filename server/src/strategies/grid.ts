import { DEFAULT_COSTS, type CostModel } from "../backtest/backtest.js";
import type { Candle } from "../types/index.js";
import { EXPIRY_MS, netR, returnPercent, type SimulatedTrade } from "./engine.js";
import { TIMEFRAME_MS } from "./types.js";

/*
 * 6. GridTrading (1h). EXEMPT from the one-position rule: up to 5 grid positions can be open at once.
 *   Range:   the highest high and lowest low of the last 20 bars.
 *   Levels:  10 evenly spaced levels across the range (the lowest level is the range low, the highest the range high).
 *   Entry:   buy at each level below the current price. Sell one level above each fill.
 *   Exit:    close all open grid positions if the close moves more than 3% outside the range (above or below).
 *
 * How the rule is applied:
 *  - The grid is set up on the close of a candle, from the last 20 bars, and then stays fixed until it is closed out by the
 *    3% rule; the next candle's close sets up a new one.
 *  - A buy order waits at every level that is below the previous close and holds no position. It fills when a candle's low
 *    reaches the level (at the level). A filled level sells at the next level up when a candle's high reaches it (a position
 *    does not sell on the candle it filled in), and the level then buys again.
 *  - Positions beyond the fifth wait. A position is also closed at market after 24 hours.
 *  - A grid position has no stop of its own. For the R-multiples its risk is the distance from its fill to the level at which
 *    the whole grid is closed out (the range low minus 3%).
 */
export const GRID = { lookback: 20, levelCount: 10, maxOpen: 5, exitOutsidePercent: 3 } as const;

export interface GridPosition {
  id: string;
  levelIndex: number;
  fillPrice: number;
  /** The next level up: where this position sells. */
  sellLevel: number;
  /** When the position filled (close of its candle), epoch ms. */
  fillTime: number;
  /** The level where the whole grid is closed out below: range low minus 3%. */
  stopRef: number;
}

export interface GridState {
  grid: { low: number; high: number; levels: number[] } | null;
  positions: GridPosition[];
  /** The close of the previous candle (buy orders wait below it). */
  lastClose: number | null;
}

export const emptyGrid = (): GridState => ({ grid: null, positions: [], lastClose: null });

export type GridEvent =
  | { type: "fill"; position: GridPosition }
  | { type: "close"; position: GridPosition; reason: "TP" | "EXIT_ALL" | "EXPIRED"; price: number; time: number };

/** One closed candle through the grid. `recent` is the last 20 candles up to and including `c`. Mutates `state`. */
export function stepGrid(state: GridState, c: Candle, recent: Candle[], tfMs: number, idPrefix: string): GridEvent[] {
  const events: GridEvent[] = [];
  const closeTime = c.time + tfMs;
  const close = (p: GridPosition, reason: "TP" | "EXIT_ALL" | "EXPIRED", price: number) => {
    state.positions = state.positions.filter((x) => x.id !== p.id);
    events.push({ type: "close", position: p, reason, price, time: closeTime });
  };

  const grid = state.grid;
  if (grid) {
    // positions that filled on an earlier candle: sell one level up, or expire after 24 hours
    for (const p of [...state.positions]) {
      if (c.high >= p.sellLevel) close(p, "TP", p.sellLevel);
      else if (closeTime - p.fillTime >= EXPIRY_MS) close(p, "EXPIRED", c.close);
    }
    // buy orders: every level below the previous close that holds no position fills when the candle's low reaches it
    if (state.lastClose !== null) {
      const held = new Set(state.positions.map((p) => p.levelIndex));
      for (let k = grid.levels.length - 2; k >= 0; k--) {
        // the top level has no level above it to sell at
        if (state.positions.length >= GRID.maxOpen) break;
        const level = grid.levels[k]!;
        if (held.has(k) || !(level < state.lastClose) || !(c.low <= level)) continue;
        const position: GridPosition = { id: `${idPrefix}:${k}:${closeTime}`, levelIndex: k, fillPrice: level, sellLevel: grid.levels[k + 1]!, fillTime: closeTime, stopRef: grid.low * (1 - GRID.exitOutsidePercent / 100) };
        state.positions.push(position);
        events.push({ type: "fill", position });
      }
    }
    // the close is more than 3% outside the range: everything closes and the grid is set up again from this candle
    if (c.close > grid.high * (1 + GRID.exitOutsidePercent / 100) || c.close < grid.low * (1 - GRID.exitOutsidePercent / 100)) {
      for (const p of [...state.positions]) close(p, "EXIT_ALL", c.close);
      state.grid = null;
    }
  }

  if (!state.grid && recent.length >= GRID.lookback) {
    const window = recent.slice(-GRID.lookback);
    const high = Math.max(...window.map((x) => x.high));
    const low = Math.min(...window.map((x) => x.low));
    if (high > low) {
      const step = (high - low) / (GRID.levelCount - 1);
      state.grid = { low, high, levels: Array.from({ length: GRID.levelCount }, (_, k) => low + k * step) };
    }
  }
  state.lastClose = c.close;
  return events;
}

/** Replays the grid over closed candles. Each closed grid position is one trade. */
export function simulateGrid(strategyId: string, candles: Candle[], startIndex: number, costs: CostModel = DEFAULT_COSTS): SimulatedTrade[] {
  const tfMs = TIMEFRAME_MS["1h"];
  const state = emptyGrid();
  const trades: SimulatedTrade[] = [];
  const indexOfFill = new Map<string, number>();
  for (let i = Math.max(1, startIndex); i < candles.length; i++) {
    const events = stepGrid(state, candles[i]!, candles.slice(Math.max(0, i - GRID.lookback + 1), i + 1), tfMs, strategyId);
    for (const e of events) {
      if (e.type === "fill") {
        indexOfFill.set(e.position.id, i);
        continue;
      }
      const p = e.position;
      trades.push({
        strategyId,
        createdAt: p.fillTime,
        entryTime: p.fillTime,
        entryIndex: indexOfFill.get(p.id) ?? i,
        entry: p.fillPrice,
        stopLoss: p.stopRef,
        exitTime: e.time,
        exitIndex: i,
        exitPrice: e.price,
        reason: e.reason,
        netR: netR(p.fillPrice, p.stopRef, e.price, costs),
        returnPercent: returnPercent(p.fillPrice, e.price),
      });
    }
  }
  return trades;
}

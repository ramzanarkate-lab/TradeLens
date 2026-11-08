import { DEFAULT_COSTS, netResultR, type CostModel } from "../backtest/backtest.js";
import type { Candle } from "../types/index.js";
import type { CloseCheck, ExitReason, Plan, Strategy, StrategyContext, StrategyTimeframe } from "./types.js";
import { TIMEFRAME_MS } from "./types.js";

/** Every open position is closed at market after this long if no level was hit. */
export const EXPIRY_MS = 24 * 3_600_000;

/** The 24-hour expiry in bars of a timeframe. */
export const expiryBarsFor = (tf: StrategyTimeframe): number => Math.floor(EXPIRY_MS / TIMEFRAME_MS[tf]);

/** Each trade risks this share of the virtual equity. */
export const RISK_PER_TRADE = 0.01;

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A position being followed. `stop` can move up (a trailing stop). */
export interface Position {
  entry: number;
  stop: number;
  target?: number;
  /** The strategy's own time exit, in bars from the signal candle. */
  maxBars?: number;
  /** The 24-hour expiry, in bars from the signal candle. */
  expiryBars: number;
}

export interface ExitResult {
  reason: ExitReason;
  price: number;
}

/**
 * Does a closed candle end the position? `barsElapsed` counts candles from the signal candle (the entry candle is 1).
 * Order inside one candle: the stop first (if the stop and the target are both reached, the stop was hit first; a stop that is
 * gapped through fills at the open), then the target, then the strategy's close rules (which may also raise a trailing stop),
 * then the strategy's time exit, then the 24-hour expiry.
 */
export function stepBar(pos: Position, bar: Bar, barsElapsed: number, onClose?: () => CloseCheck | null): ExitResult | null {
  if (bar.low <= pos.stop) return { reason: "SL", price: Math.min(pos.stop, bar.open) };
  if (pos.target !== undefined && bar.high >= pos.target) return { reason: "TP", price: pos.target };
  const check = onClose?.() ?? null;
  if (check?.exit) return { reason: "EXIT_SIGNAL", price: bar.close };
  if (check?.stop !== undefined) pos.stop = Math.max(pos.stop, check.stop);
  if (pos.maxBars !== undefined && barsElapsed >= pos.maxBars) return { reason: "TIME", price: bar.close };
  if (barsElapsed >= pos.expiryBars) return { reason: "EXPIRED", price: bar.close };
  return null;
}

/** A live price: only a level can end a position between candle closes. */
export function tickExit(pos: Pick<Position, "stop" | "target">, price: number): ExitResult | null {
  if (price <= pos.stop) return { reason: "SL", price: Math.min(pos.stop, price) };
  if (pos.target !== undefined && price >= pos.target) return { reason: "TP", price: pos.target };
  return null;
}

/** Net result in R after fees and slippage (risk = entry to the first stop). */
export function netR(entry: number, stop: number, exit: number, costs: CostModel = DEFAULT_COSTS): number {
  return netResultR("BUY", entry, stop, exit, costs);
}

/** Price change from the entry to the exit, in percent (before costs). */
export const returnPercent = (entry: number, exit: number): number => ((exit - entry) / entry) * 100;

export interface SimulatedTrade {
  strategyId: string;
  /** Close time of the signal candle: when the signal was made. */
  createdAt: number;
  entryTime: number;
  entryIndex: number;
  /** The open of the entry candle, before slippage. */
  entry: number;
  /** The first stop (it defines the risk, 1R). */
  stopLoss: number;
  exitTime: number;
  exitIndex: number;
  exitPrice: number;
  reason: ExitReason;
  netR: number;
  returnPercent: number;
}

/**
 * Replays a standard strategy over closed candles one candle at a time, exactly as the live generator does:
 *  - a signal is found on the close of candle i and the position enters at the OPEN of candle i+1;
 *  - the entry candle's own high and low can already hit the stop or target;
 *  - one open position at a time per strategy;
 *  - the same exit rules, costs (fees and slippage, see backtest.ts) and 24-hour expiry.
 * A position still open when the data ends is left out. Signals are looked for from candle `startIndex`.
 */
export function simulateStandard(strategy: Strategy, candles: Candle[], ctx: StrategyContext, startIndex = strategy.warmup, costs: CostModel = DEFAULT_COSTS): SimulatedTrade[] {
  const inst = strategy.create(candles, ctx);
  const tfMs = TIMEFRAME_MS[strategy.timeframe];
  const expiryBars = expiryBarsFor(strategy.timeframe);
  const trades: SimulatedTrade[] = [];
  let pending: { plan: Plan; signalIndex: number } | null = null;
  let open: { plan: Plan; pos: Position; signalIndex: number; entryIndex: number; entry: number; firstStop: number } | null = null;

  for (let i = Math.max(1, startIndex); i < candles.length; i++) {
    const c = candles[i]!;

    if (pending) {
      const entry = c.open; // the next candle's open
      const levels = pending.plan.levels(entry);
      if (levels.stopLoss < entry) {
        open = {
          plan: pending.plan,
          pos: { entry, stop: levels.stopLoss, target: levels.targets[0], maxBars: pending.plan.maxBars, expiryBars },
          signalIndex: pending.signalIndex,
          entryIndex: i,
          entry,
          firstStop: levels.stopLoss,
        };
      }
      pending = null;
    }

    if (open) {
      const o = open;
      const result = stepBar(o.pos, c, i - o.signalIndex, () => o.plan.onClose?.(i, { entry: o.entry, stop: o.pos.stop, entryIndex: o.entryIndex }) ?? null);
      if (result) {
        trades.push({
          strategyId: strategy.id,
          createdAt: candles[o.signalIndex]!.time + tfMs,
          entryTime: candles[o.entryIndex]!.time,
          entryIndex: o.entryIndex,
          entry: o.entry,
          stopLoss: o.firstStop,
          exitTime: c.time + tfMs,
          exitIndex: i,
          exitPrice: result.price,
          reason: result.reason,
          netR: netR(o.entry, o.firstStop, result.price, costs),
          returnPercent: returnPercent(o.entry, result.price),
        });
        open = null;
      }
    }

    if (!open && !pending) {
      const plan = inst.signal(i);
      if (plan) pending = { plan, signalIndex: i };
    }
  }
  return trades;
}

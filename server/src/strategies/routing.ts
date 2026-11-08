import type { Logger } from "../logging/logger.js";
import type { Signal, SignalStatus } from "../types/index.js";
import type { RouteHooks } from "./generator.js";
import type { StrategySignal } from "./signalStore.js";

/** The parts of the Telegram notifier and the demo engine that routing uses. */
export interface RoutingTargets {
  telegram: { newSignal(signal: Signal): Promise<void> | void };
  demo: { onSignal(signal: Signal): void; onUpdate(signal: Signal): void };
}

/** Hours after which an open strategy signal is closed at market. */
export const EXPIRY_HOURS = 24;

/**
 * A validated strategy signal in the shape the notifier and the demo engine understand.
 * Returns null when the strategy has no price targets: the TP1/TP2/TP3 messages and the demo ladder cannot describe it.
 */
export function toSignal(s: StrategySignal): Signal | null {
  if (s.tp1 === undefined || s.tp2 === undefined || s.tp3 === undefined) return null;
  const zero = { P: 0, R1: 0, R2: 0, R3: 0, S1: 0, S2: 0, S3: 0 };
  return {
    id: s.id,
    symbol: s.symbol as Signal["symbol"],
    side: s.direction,
    timeframe: s.timeframe,
    price: s.entry,
    levels: { S1: 0, R2: 0, pivots: zero },
    indicators: { emaFast: 0, emaSlow: 0, rsi: 0 },
    trigger: "multi_indicator",
    reason: s.strategyId,
    createdAt: s.createdAt,
    mode: "live",
    entry: s.entry,
    sl: s.stopLoss,
    tp1: s.tp1,
    tp2: s.tp2,
    tp3: s.tp3,
    status: "OPEN",
    statusHistory: [{ status: "OPEN", at: s.createdAt, price: s.entry, resultR: null }],
    closedAt: null,
    resultR: null,
    expiryHours: EXPIRY_HOURS,
  };
}

/** The closed form of a signal, for the demo engine: it closes any trade still open at the exit price. */
export function toClosedSignal(s: StrategySignal): Signal | null {
  const open = toSignal(s);
  if (!open || !s.outcome) return null;
  const status: SignalStatus = s.outcome.reason === "TP" ? "TP3_HIT" : s.outcome.reason === "SL" ? "SL_HIT" : "TIME_EXIT";
  return { ...open, status, closedAt: s.outcome.closedAt, resultR: s.outcome.netR, statusHistory: [...open.statusHistory!, { status, at: s.outcome.closedAt, price: s.outcome.exitPrice, resultR: s.outcome.netR }] };
}

/**
 * The only route to Telegram and to demo trades. A signal that is not validated is stopped here (again): it is stored by the
 * generator for backtest and logging, and nothing else is ever done with it.
 */
export function createRouting(targets: RoutingTargets, logger: Pick<Logger, "info" | "warn">): RouteHooks {
  return {
    onValidatedSignal(signal) {
      if (!signal.validated || signal.researchOnly) return;
      const converted = toSignal(signal);
      if (!converted) {
        logger.warn({ id: signal.id, strategyId: signal.strategyId }, "validated strategy has no price targets: not posted and not traded (no message template for it)");
        return;
      }
      targets.demo.onSignal(converted);
      void targets.telegram.newSignal(converted);
    },
    onValidatedClosed(signal) {
      if (!signal.validated || signal.researchOnly) return;
      const converted = toClosedSignal(signal);
      if (converted) targets.demo.onUpdate(converted);
    },
  };
}

import type { Signal, StatusChange } from "../types/index.js";

/** Statuses of a signal that is still running. */
export const ACTIVE_STATUSES = ["OPEN", "TP1_HIT", "TP2_HIT"] as const;

export const isActive = (s: Pick<Signal, "status">): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s.status ?? "");

/** A price window: a closed candle, or a single live price (high = low = close). */
export interface PriceBar {
  high: number;
  low: number;
  close: number;
  /** Epoch ms when this bar closed (or the time of the live price). */
  at: number;
}

export interface AdvanceResult {
  signal: Signal;
  changes: StatusChange[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** R-multiple of closing at `price`: positive when it moved in the signal's favour. */
export function rMultiple(signal: Pick<Signal, "side" | "entry" | "sl">, price: number): number {
  const risk = Math.abs(signal.entry! - signal.sl!);
  const move = signal.side === "BUY" ? price - signal.entry! : signal.entry! - price;
  return r2(move / risk);
}

/**
 * Moves a signal forward through one price bar.
 *  - After TP1 the stop moves to the entry.
 *  - If a bar touches both the stop and a target, the stop counts first (the conservative assumption).
 *  - Statuses: SL_HIT (stop at the original level), BREAKEVEN_EXIT (stop at the entry after TP1),
 *    TP3_HIT (final target), TIME_EXIT (still running after `timeStopHours`, closed at the bar's close).
 * Each change is recorded with its time, price and R-multiple. The input is not modified.
 */
export function advance(input: Signal, bar: PriceBar, timeStopHours: number): AdvanceResult {
  const signal: Signal = { ...input, statusHistory: [...(input.statusHistory ?? [])] };
  const changes: StatusChange[] = [];
  if (!isActive(signal)) return { signal, changes };

  const buy = signal.side === "BUY";
  const entry = signal.entry!;
  const touchesStop = (level: number) => (buy ? bar.low <= level : bar.high >= level);
  const touchesTarget = (level: number) => (buy ? bar.high >= level : bar.low <= level);

  const record = (status: StatusChange["status"], price: number, resultR: number) => {
    const change: StatusChange = { status, at: bar.at, price, resultR };
    signal.status = status;
    signal.statusHistory!.push(change);
    changes.push(change);
  };
  const close = (resultR: number) => {
    signal.closedAt = bar.at;
    signal.resultR = resultR;
  };

  while (isActive(signal)) {
    const stop = signal.status === "OPEN" ? signal.sl! : entry;
    if (touchesStop(stop)) {
      if (signal.status === "OPEN") {
        record("SL_HIT", stop, -1);
        close(-1);
      } else {
        record("BREAKEVEN_EXIT", entry, 0);
        close(0);
      }
      break;
    }
    const next =
      signal.status === "OPEN"
        ? ({ status: "TP1_HIT", level: signal.tp1!, rr: signal.rrTp1! } as const)
        : signal.status === "TP1_HIT"
          ? ({ status: "TP2_HIT", level: signal.tp2!, rr: signal.rrTp2! } as const)
          : ({ status: "TP3_HIT", level: signal.tp3!, rr: signal.rrTp3! } as const);
    if (!touchesTarget(next.level)) break;
    record(next.status, next.level, next.rr);
    if (next.status === "TP3_HIT") close(next.rr);
  }

  if (isActive(signal) && bar.at - signal.createdAt >= timeStopHours * 3_600_000) {
    const result = rMultiple(signal, bar.close);
    record("TIME_EXIT", bar.close, result);
    close(result);
  }
  return { signal, changes };
}

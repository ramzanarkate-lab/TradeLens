import { blendedPercent, type DemoEvent, type DemoTrade } from "../demotrade/demoTrader.js";
import { movePercent } from "../signals/levels.js";
import type { EventSource, TelegramNotifier } from "./telegramNotifier.js";

/**
 * Turns one event of a trade into the matching Telegram message:
 *   TP1 -> "TP1 HIT"          TP2 -> "TP2 HIT"          TP3 -> "TP3 HIT, TRADE CLOSED"
 *   stop before TP1 -> "STOP LOSS HIT"          stop after TP1 or TP2 -> "TRADE CLOSED"
 *   time limit before any target -> "SIGNAL EXPIRED"          time limit after a target -> "TRADE CLOSED" (closed at market)
 * The opening of a trade is the signal itself and is announced by the notifier's newSignal.
 */
export function announceTradeEvent(notifier: TelegramNotifier, trade: DemoTrade, event: DemoEvent, source: EventSource, timeStopHours: number): Promise<void> {
  const info = { symbol: trade.symbol, side: trade.side };
  const duration = event.at - trade.openedAt;
  switch (event.level) {
    case "TP1":
      return notifier.tp1Hit(trade.id, { ...info, price: event.price, entry: trade.entry, at: event.at }, source);
    case "TP2":
      return notifier.tp2Hit(trade.id, { ...info, price: event.price, tp1: trade.tp1, at: event.at }, source);
    case "TP3":
      return notifier.tp3Hit(
        trade.id,
        { ...info, exit: event.price, resultPercent: blendedPercent(trade), exits: trade.events.filter((e) => e.level !== "OPEN").length, durationMs: duration, at: event.at },
        source,
      );
    case "SL":
    case "TIME": {
      if (trade.levels.tp1 !== "HIT") {
        if (event.level === "SL") return notifier.stopLossHit(trade.id, { ...info, exit: event.price, resultPercent: blendedPercent(trade), durationMs: duration, at: event.at }, source);
        return notifier.signalExpired(trade.id, { ...info, hours: trade.expiryHours ?? timeStopHours, price: event.price, resultPercent: movePercent(trade.side, trade.entry, event.price), at: event.at }, source);
      }
      return notifier.closedAfterTp(
        trade.id,
        {
          ...info,
          hits: trade.events
            .filter((e) => e.level === "TP1" || e.level === "TP2")
            .map((e) => ({ level: e.level as "TP1" | "TP2", percent: movePercent(trade.side, trade.entry, e.price), share: e.closedPercent })),
          remainingPercent: event.closedPercent,
          stoppedAt: event.level === "TIME" ? "market" : trade.stage === 1 ? "entry" : "TP1",
          netPercent: blendedPercent(trade),
          at: event.at,
        },
        source,
      );
    }
    default:
      return Promise.resolve();
  }
}

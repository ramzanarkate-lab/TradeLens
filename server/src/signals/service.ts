import type { Logger } from "../logging/logger.js";
import { TIMEFRAME_MS } from "../market/aggregate.js";
import type { MarketService, Publisher } from "../market/service.js";
import type { Candle, Signal } from "../types/index.js";
import { isSymbol, type Symbol } from "../config/symbols.js";
import type { SignalEngine } from "./engine.js";
import type { SignalSettingsProvider } from "./settingsProvider.js";
import type { SignalStore } from "./store.js";

const MINUTE = 60_000;
const CANDLES_FOR_ANALYSIS = 200;

interface CandleEvents {
  on(event: "candle", listener: (symbol: Symbol, candle: Candle) => void): unknown;
}

export interface SignalServiceDeps {
  market: Pick<MarketService, "getFreshCandles" | "getPivots">;
  stream: CandleEvents;
  engine: SignalEngine;
  store: SignalStore;
  settings: SignalSettingsProvider;
  hub?: Publisher;
  logger: Logger;
}

/**
 * Runs the engine once per closed candle of the configured timeframe. The 1m stream is the clock:
 * when a closed 1m candle ends a timeframe bucket, that timeframe's candle has just closed.
 */
export class SignalService {
  private readonly listeners: Array<(signal: Signal) => void> = [];

  constructor(private readonly deps: SignalServiceDeps) {}

  /** Called for every new signal after it is stored (used by the Telegram poster). A throwing listener never stops the engine. */
  onSignal(listener: (signal: Signal) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    this.deps.stream.on("candle", (symbol, candle) => {
      if (!candle.closed || !isSymbol(symbol)) return;
      const settings = this.deps.settings.get();
      if (!settings.enabled || !settings.enabledSymbols.includes(symbol)) return;
      const tfMs = TIMEFRAME_MS[settings.timeframe];
      if ((candle.time + MINUTE) % tfMs !== 0) return; // not the last minute of a bucket
      void this.process(symbol, settings.timeframe);
    });
  }

  /** Fetches fresh candles and pivots, evaluates, then stores and publishes any signal. */
  async process(symbol: Symbol, timeframe: SignalTimeframe): Promise<Signal | null> {
    const { market, engine, store, hub, logger } = this.deps;
    try {
      const [candles, pivots] = await Promise.all([
        market.getFreshCandles(symbol, timeframe, CANDLES_FOR_ANALYSIS),
        market.getPivots(symbol),
      ]);
      const signal = engine.evaluate({ symbol, timeframe, candles, pivots });
      if (!signal) return null;
      await store.add(signal);
      hub?.broadcast("signals", { event: "signal", signal });
      for (const listener of this.listeners) {
        try {
          listener(signal);
        } catch (err) {
          logger.error({ err }, "signal listener failed");
        }
      }
      logger.info({ id: signal.id, symbol, side: signal.side, price: signal.price, reason: signal.reason }, "signal emitted");
      return signal;
    } catch (err) {
      logger.error({ err, symbol, timeframe }, "signal evaluation failed");
      return null;
    }
  }
}

type SignalTimeframe = Parameters<MarketService["getFreshCandles"]>[1];

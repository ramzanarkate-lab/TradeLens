import { isSymbol, type Symbol } from "../config/symbols.js";
import type { SignalSettings } from "../config/signalDefaults.js";
import type { Logger } from "../logging/logger.js";
import type { MarketService, Publisher } from "../market/service.js";
import type { Candle, Signal, SignalSide, StatusChange } from "../types/index.js";
import type { NewsEvaluation } from "./newsFilter.js";
import { evaluateAt, prepareContext, type EngineConfig } from "./engine.v2.js";
import { advance } from "./lifecycle.js";
import { HOUR_MS, loadMtf } from "./mtf.js";
import type { SignalSettingsProvider } from "./settingsProvider.js";
import type { SignalStore } from "./store.js";

const MINUTE = 60_000;

interface CandleEvents {
  on(event: "candle", listener: (symbol: Symbol, candle: Candle) => void): unknown;
}

export interface SignalServiceV2Deps {
  market: Pick<MarketService, "getFreshCandles">;
  stream: CandleEvents;
  store: SignalStore;
  settings: SignalSettingsProvider;
  hub?: Publisher;
  logger: Logger;
  now?: () => number;
  /** false = the SignalRunner decides when to evaluate; the stream then only feeds live prices. Default true. */
  hourlyFromStream?: boolean;
  /** News decision for a signal the engine already has (see src/news/service.ts). Absent = no news filter. */
  news?: (symbol: Symbol, side: SignalSide, settings: SignalSettings) => NewsEvaluation;
}

/**
 * Runs the multi-indicator engine once per closed 1H candle, and keeps every running signal up to date:
 * each new 1H candle and each live price is checked against its stop and targets.
 */
export class SignalServiceV2 {
  private readonly newListeners: Array<(signal: Signal) => void> = [];
  private readonly updateListeners: Array<(signal: Signal, change: StatusChange) => void> = [];
  private readonly now: () => number;

  constructor(private readonly deps: SignalServiceV2Deps) {
    this.now = deps.now ?? Date.now;
  }

  /** Called for every new signal after it is stored. A throwing listener never stops the engine. */
  onSignal(listener: (signal: Signal) => void): void {
    this.newListeners.push(listener);
  }

  /** Called for every status change of a stored signal (TP1_HIT, SL_HIT, ...). */
  onUpdate(listener: (signal: Signal, change: StatusChange) => void): void {
    this.updateListeners.push(listener);
  }

  start(): void {
    this.deps.stream.on("candle", (symbol, candle) => {
      if (!isSymbol(symbol)) return;
      this.checkPrice(symbol, candle.close, this.now());
      if (!candle.closed) return;
      const settings = this.deps.settings.get();
      if (!settings.enabled || !settings.enabledSymbols.includes(symbol)) return;
      if (this.deps.hourlyFromStream === false) return;
      if ((candle.time + MINUTE) % HOUR_MS !== 0) return; // not the last minute of an hour
      void this.processHour(symbol);
    });
  }

  private config(s: SignalSettings): EngineConfig {
    return {
      minScore: s.minScore,
      minRiskPercent: s.minRiskPercent,
      maxRiskPercent: s.maxRiskPercent,
      mode: s.mode,
      reversal: { enabled: s.reversalEnabled, minVolumeRatio: s.reversalMinVolumeRatio, levelToleranceAtr: s.reversalLevelToleranceAtr, patterns: s.reversalPatterns },
    };
  }

  /** A 1H candle just closed: advance running signals, then look for a new signal. */
  async processHour(symbol: Symbol, rethrow = false): Promise<Signal | null> {
    const { market, store, hub, logger } = this.deps;
    try {
      const series = await loadMtf(market, symbol);
      const settings = this.deps.settings.get();
      this.trackCandles(symbol, series.h1, settings.timeStopHours);

      const ctx = prepareContext(symbol, series);
      const i = series.h1.length - 1;
      const last = series.h1[i];
      if (!last) return null;
      // One evaluation per candle: skip if a signal for this candle already exists.
      if (store.all().some((s) => s.symbol === symbol && s.createdAt === last.time + HOUR_MS)) return null;
      const news = this.deps.news;
      const outcome = evaluateAt(ctx, i, {
        config: this.config(settings),
        hasOpen: (sym, side) => store.hasActive(sym, side),
        news: news ? (sym, side) => news(sym, side, settings) : undefined,
      });
      if (!outcome.signal) {
        logger.debug({ symbol, reason: outcome.reason }, "no signal");
        return null;
      }
      const signal = outcome.signal;
      await store.add(signal);
      hub?.broadcast("signals", { event: "signal", signal });
      for (const listener of this.newListeners) this.safely(() => listener(signal));
      logger.info({ id: signal.id, symbol, side: signal.side, score: signal.score, entry: signal.entry, sl: signal.sl, mode: signal.mode }, "signal emitted");
      return signal;
    } catch (err) {
      logger.error({ err, symbol }, "signal evaluation failed");
      if (rethrow) throw err;
      return null;
    }
  }

  /** Checks every running signal of the symbol against closed 1H candles it has not seen yet. */
  trackCandles(symbol: Symbol, h1: Candle[], timeStopHours: number): void {
    for (const running of this.deps.store.active(symbol)) {
      for (const candle of h1) {
        const current = this.deps.store.get(running.id)!;
        if (current.closedAt) break;
        // Only candles that opened at or after the signal was created, and each one once.
        if (candle.time < current.createdAt || candle.time <= (current.lastCheckedCandle ?? -1)) continue;
        const result = advance(current, { high: candle.high, low: candle.low, close: candle.close, at: candle.time + HOUR_MS }, timeStopHours);
        result.signal.lastCheckedCandle = candle.time;
        this.save(result.signal, result.changes);
      }
    }
  }

  /** A live price: a stop or target can be hit between candle closes. */
  checkPrice(symbol: Symbol, price: number, at: number): void {
    const { timeStopHours } = this.deps.settings.get();
    for (const running of this.deps.store.active(symbol)) {
      const result = advance(running, { high: price, low: price, close: price, at }, timeStopHours);
      if (result.changes.length > 0) this.save(result.signal, result.changes);
    }
  }

  private save(signal: Signal, changes: StatusChange[]): void {
    void this.deps.store.update(signal);
    for (const change of changes) {
      this.deps.hub?.broadcast("signals", { event: "signalUpdate", signal, change });
      this.deps.logger.info({ id: signal.id, symbol: signal.symbol, status: change.status, resultR: change.resultR }, "signal status changed");
      for (const listener of this.updateListeners) this.safely(() => listener(signal, change));
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.logger.error({ err }, "signal listener failed");
    }
  }
}

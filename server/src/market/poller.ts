import { EventEmitter } from "node:events";
import { SYMBOLS, type Symbol } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import type { Candle } from "../types/index.js";
import type { FeedStatus } from "./binanceWs.js";

export const POLL_INTERVAL_MS = 5_000;
export const LIVE_WITHIN_MS = 15_000;

export interface TickerInfo {
  price: number;
  change24h: number;
  changePercent24h: number;
}

export interface MarketPollerOptions {
  /** Where candles come from (the provider registry). */
  source: {
    fetchKlines(symbol: Symbol, interval: "1m", limit: number): Promise<Candle[]>;
    fetchTicker24h?(symbol: Symbol): Promise<TickerInfo>;
  };
  logger: Logger;
  /** Symbols to poll on each cycle. Defaults to all three. */
  symbols?: () => readonly Symbol[];
  intervalMs?: number;
  now?: () => number;
}

/**
 * Live prices without a WebSocket: every 5 seconds it fetches the newest 1m candles for each symbol and emits them
 * exactly like the Binance stream does, so the rest of the server (hub, signal engine) does not change.
 * Emits "candle" (symbol, candle) and "status" ("Live" | "Offline").
 * Status is Live while a poll succeeded within the last 15 seconds.
 */
export class MarketPoller extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private running = false;
  private status: FeedStatus = "Offline";
  private readonly latest = new Map<string, Candle>();
  private readonly lastClosed = new Map<string, number>();
  private readonly lastSuccess = new Map<string, number>();
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly opts: MarketPollerOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.pollOnce();
      if (this.running) {
        this.timer = setTimeout(() => void loop(), this.intervalMs);
        this.timer.unref?.();
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  /** Live if any poll succeeded in the last 15 seconds, otherwise Offline. */
  getStatus(): FeedStatus {
    const last = Math.max(0, ...this.lastSuccess.values());
    return last > 0 && this.now() - last <= LIVE_WITHIN_MS ? "Live" : "Offline";
  }

  getLatest(symbol: string): Candle | undefined {
    return this.latest.get(symbol);
  }

  /** Last successful poll time (epoch ms) per symbol, or null if it never succeeded. */
  lastPolls(): Record<Symbol, number | null> {
    return Object.fromEntries(SYMBOLS.map((s) => [s, this.lastSuccess.get(s) ?? null])) as Record<Symbol, number | null>;
  }

  /** One cycle for every symbol, in parallel. A failing symbol never stops the others. */
  async pollOnce(): Promise<void> {
    const symbols = this.opts.symbols?.() ?? SYMBOLS;
    await Promise.all(symbols.map((symbol) => this.pollSymbol(symbol)));
    this.updateStatus();
  }

  private async pollSymbol(symbol: Symbol): Promise<void> {
    try {
      const [candles, ticker] = await Promise.all([
        this.opts.source.fetchKlines(symbol, "1m", 2),
        // A failing ticker never stops the candle: the 24h change is a bonus, the price comes from the candle.
        this.opts.source.fetchTicker24h?.(symbol).catch(() => undefined),
      ]);
      this.lastSuccess.set(symbol, this.now());
      const doneUpTo = this.lastClosed.get(symbol) ?? -1;
      for (const candle of candles) {
        // A candle that has closed is announced once; the forming one is sent on every cycle.
        if (candle.closed) {
          if (candle.time <= doneUpTo) continue;
          this.lastClosed.set(symbol, candle.time);
        }
        this.latest.set(symbol, candle);
        this.emit("candle", symbol, candle, ticker);
      }
    } catch (err) {
      this.opts.logger.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, "market poll failed");
    }
  }

  private updateStatus(): void {
    const next = this.getStatus();
    if (next === this.status) return;
    this.status = next;
    this.emit("status", next);
  }
}

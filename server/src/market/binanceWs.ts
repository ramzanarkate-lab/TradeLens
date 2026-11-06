import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { SYMBOLS, isSymbol } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import type { Candle } from "../types/index.js";

export type FeedStatus = "Live" | "Reconnecting" | "Offline";

/** What the market service needs from a live feed: the Binance WebSocket stream or the polling feed. */
export interface MarketFeed {
  start(): void;
  stop(): void;
  getStatus(): FeedStatus;
  getLatest(symbol: string): Candle | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches EventEmitter.on
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** Optional WebSocket path (MARKET_STREAM=websocket, Binance provider only). */
export const BINANCE_DEFAULT_WS_URL = "wss://stream.binance.com:9443";

export function buildStreamUrl(baseUrl: string = BINANCE_DEFAULT_WS_URL, symbols: readonly string[] = SYMBOLS): string {
  const streams = symbols.map((s) => `${s.toLowerCase()}@kline_1m`).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/stream?streams=${streams}`;
}

/** Parses one combined-stream message into [symbol, candle], or null if it is not a valid kline event. */
export function parseKlineMessage(raw: string): [string, Candle] | null {
  let msg: { data?: { e?: string; s?: string; k?: Record<string, unknown> } } | null;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  const data = msg?.data;
  const k = data?.k;
  if (data?.e !== "kline" || !k) return null;
  const symbol = String(data.s ?? "").toUpperCase();
  if (!isSymbol(symbol)) return null;
  const candle: Candle = {
    time: Number(k.t),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closed: Boolean(k.x),
  };
  if (Object.values(candle).some((v) => typeof v === "number" && !Number.isFinite(v))) return null;
  return [symbol, candle];
}

export interface BinanceStreamOptions {
  /** Full combined-stream URL, e.g. buildStreamUrl("wss://stream.binance.com:9443"). */
  url: string;
  logger: Logger;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Reconnect if nothing is received for this long. */
  staleMs?: number;
}

/**
 * One combined 1m kline stream for all symbols. Emits:
 *  - "candle" (symbol, candle) for every kline update
 *  - "status" (FeedStatus) when the connection goes Live or Reconnecting
 */
export class BinanceStream extends EventEmitter {
  private ws?: WebSocket;
  private stopped = true;
  private status: FeedStatus = "Reconnecting";
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private readonly latest = new Map<string, Candle>();
  private readonly logger: Logger;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly staleMs: number;

  constructor(private readonly opts: BinanceStreamOptions) {
    super();
    this.logger = opts.logger.child({ module: "binanceWs" });
    this.minDelayMs = opts.minDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.staleMs = opts.staleMs ?? 60_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.staleTimer);
    this.ws?.removeAllListeners();
    this.ws?.on("error", () => undefined); // terminate() on a connecting socket emits an error
    this.ws?.terminate();
    this.ws = undefined;
  }

  getStatus(): FeedStatus {
    return this.status;
  }

  getLatest(symbol: string): Candle | undefined {
    return this.latest.get(symbol);
  }

  private connect(): void {
    this.logger.info({ url: this.opts.url, attempt: this.attempt }, "connecting to market stream");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.armStaleTimer();
      this.setStatus("Live");
      this.logger.info("market stream connected");
    });
    ws.on("message", (raw) => {
      this.armStaleTimer();
      const parsed = parseKlineMessage(raw.toString());
      if (!parsed) return;
      const [symbol, candle] = parsed;
      this.latest.set(symbol, candle);
      this.emit("candle", symbol, candle);
    });
    ws.on("error", (err) => this.logger.warn({ err: err.message }, "market stream error"));
    ws.on("close", (code) => {
      if (this.stopped || this.ws !== ws) return;
      clearTimeout(this.staleTimer);
      this.setStatus("Reconnecting");
      const delay = Math.min(this.maxDelayMs, this.minDelayMs * 2 ** this.attempt);
      this.attempt++;
      this.logger.warn({ code, attempt: this.attempt, delayMs: delay }, "market stream closed, reconnecting");
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private armStaleTimer(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.logger.warn({ staleMs: this.staleMs }, "market stream went quiet, forcing reconnect");
      this.ws?.terminate();
    }, this.staleMs);
  }

  private setStatus(status: FeedStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }
}

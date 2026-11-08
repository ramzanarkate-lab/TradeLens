import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PRICE_DECIMALS } from "../analysis/pivots.js";
import type { Logger } from "../logging/logger.js";
import { movePercent } from "../signals/levels.js";
import type { Signal, SignalSide } from "../types/index.js";
import type { SendResult } from "./telegramClient.js";

// ---------------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Decimals of a price: the symbol's tick size, or 4 below 1 and 2 above for a symbol we do not know. */
export function decimalsFor(symbol: string, price: number): number {
  const known = (PRICE_DECIMALS as Record<string, number | undefined>)[symbol];
  return known ?? (Math.abs(price) < 1 ? 4 : 2);
}

/** "64,250.00": thousands separators and a fixed number of decimals. */
export function formatPrice(symbol: string, price: number): string {
  const d = decimalsFor(symbol, price);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(price);
}

/** "+1.0%" or "-1.3%" (a profit is positive, a loss negative). */
export function formatPercent(value: number, decimals = 1): string {
  const rounded = Number(value.toFixed(decimals));
  return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded).toFixed(decimals)}%`;
}

/** "2026-11-07 11:45 (UTC+3)" in the given IANA zone (the channel uses UTC+3, Asia/Riyadh). */
export function formatTime(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // "GMT+03:00" -> "UTC+3", "GMT+05:30" -> "UTC+5:30", "GMT" -> "UTC"
  const offset = get("timeZoneName")
    .replace("GMT", "UTC")
    .replace(/([+-])0?(\d{1,2}):00$/, "$1$2")
    .replace(/([+-])0?(\d{1,2}):(\d{2})$/, "$1$2:$3")
    .replace(/UTC[+-]0$/, "UTC");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} (${offset})`;
}

/** "4h 12m", "1h 40m", "35m". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const DISCLAIMER = "Signals are not financial advice. Trade at your own risk.";

/** What the message builders need to know about a trade. Values come from the trade data, never from this file. */
export interface TradeInfo {
  symbol: string;
  side: SignalSide;
}
export interface Tp1Event extends TradeInfo {
  price: number;
  /** The entry price: the stop moves here. */
  entry: number;
  at: number;
}
export interface Tp2Event extends TradeInfo {
  price: number;
  /** The TP1 price: the stop moves here. */
  tp1: number;
  at: number;
}
export interface Tp3Event extends TradeInfo {
  exit: number;
  /** Profit in percent, blended over every exit. */
  resultPercent: number;
  exits: number;
  durationMs: number;
  at: number;
}
export interface StopLossEvent extends TradeInfo {
  exit: number;
  resultPercent: number;
  durationMs: number;
  at: number;
}
export interface ClosedAfterTpEvent extends TradeInfo {
  /** The targets that were hit, each with its profit in percent and the share of the position it closed. */
  hits: Array<{ level: "TP1" | "TP2"; percent: number; share: number }>;
  /** Share of the position that was still open, in percent. */
  remainingPercent: number;
  stoppedAt: "entry" | "TP1" | "market";
  /** Net result over the whole position, in percent (shown with two decimals). */
  netPercent: number;
  at: number;
}
export interface ExpiredEvent extends TradeInfo {
  /** Hours the signal was allowed to run. */
  hours: number;
  /** The market price it was closed at. */
  price: number;
  resultPercent: number;
  at: number;
}

const bold = (s: string) => `<b>${escapeHtml(s)}</b>`;

/** One pure function per message. Each returns the exact text sent to Telegram (parse_mode HTML). */
export const messages = {
  /** 🟢 BUY SIGNAL / 🔴 SELL SIGNAL. Percentages are from the entry, in the trade's direction (a loss is negative). */
  newSignal(signal: Signal, timeZone: string): string {
    const entry = signal.entry ?? signal.price;
    const sl = signal.sl!;
    const [tp1, tp2, tp3] = [signal.tp1!, signal.tp2!, signal.tp3!];
    const p = (v: number) => formatPercent(movePercent(signal.side, entry, v));
    const rr = Math.abs(tp2 - entry) / Math.abs(entry - sl);
    return [
      `${signal.side === "BUY" ? "🟢" : "🔴"} ${bold(`${signal.side} SIGNAL: ${signal.symbol}`)}`,
      "",
      `Entry: ${formatPrice(signal.symbol, entry)}`,
      `Stop Loss: ${formatPrice(signal.symbol, sl)} (${p(sl)})`,
      `TP1: ${formatPrice(signal.symbol, tp1)} (${p(tp1)})`,
      `TP2: ${formatPrice(signal.symbol, tp2)} (${p(tp2)})`,
      `TP3: ${formatPrice(signal.symbol, tp3)} (${p(tp3)})`,
      "",
      `Risk/Reward (to TP2): 1:${rr.toFixed(1)}`,
      `Time: ${formatTime(signal.createdAt, timeZone)}`,
      "",
      `<i>${DISCLAIMER}</i>`,
    ].join("\n");
  },

  tp1Hit(e: Tp1Event, timeZone: string): string {
    return [
      `🎯 ${bold(`TP1 HIT: ${e.symbol} ${e.side}`)}`,
      "",
      `Price: ${formatPrice(e.symbol, e.price)}`,
      "Closed: 25% of position",
      `Stop loss moved to entry (${formatPrice(e.symbol, e.entry)})`,
      `Time: ${formatTime(e.at, timeZone)}`,
    ].join("\n");
  },

  tp2Hit(e: Tp2Event, timeZone: string): string {
    return [
      `🎯🎯 ${bold(`TP2 HIT: ${e.symbol} ${e.side}`)}`,
      "",
      `Price: ${formatPrice(e.symbol, e.price)}`,
      "Closed: another 25%",
      `Stop loss moved to TP1 (${formatPrice(e.symbol, e.tp1)})`,
      `Time: ${formatTime(e.at, timeZone)}`,
    ].join("\n");
  },

  tp3Hit(e: Tp3Event, timeZone: string): string {
    return [
      `🏁 ${bold(`TP3 HIT: ${e.symbol} ${e.side}, TRADE CLOSED`)}`,
      "",
      `Exit: ${formatPrice(e.symbol, e.exit)}`,
      `Result: ${formatPercent(e.resultPercent)} (blended across ${e.exits} exits)`,
      `Duration: ${formatDuration(e.durationMs)}`,
      `Time: ${formatTime(e.at, timeZone)}`,
    ].join("\n");
  },

  stopLossHit(e: StopLossEvent, timeZone: string): string {
    return [
      `🛑 ${bold(`STOP LOSS HIT: ${e.symbol} ${e.side}`)}`,
      "",
      `Exit: ${formatPrice(e.symbol, e.exit)}`,
      `Result: ${formatPercent(e.resultPercent)}`,
      `Duration: ${formatDuration(e.durationMs)}`,
      `Time: ${formatTime(e.at, timeZone)}`,
      "",
      "Losses are part of the strategy. Review the trade history for details.",
    ].join("\n");
  },

  /** A trade that hit TP1 (and maybe TP2) and then closed the rest: at the entry, at TP1, or at the market price. */
  closedAfterTp(e: ClosedAfterTpEvent, timeZone: string): string {
    const stopped = e.stoppedAt === "market" ? "closed at market" : `stopped at ${e.stoppedAt}`;
    return [
      `⚖️ ${bold(`TRADE CLOSED: ${e.symbol} ${e.side}`)}`,
      "",
      ...e.hits.map((h) => `${h.level} hit (${formatPercent(h.percent)} on ${h.share}%)`),
      `Remaining ${e.remainingPercent}% ${stopped}`,
      `Net result: ${formatPercent(e.netPercent, 2)}`,
      `Time: ${formatTime(e.at, timeZone)}`,
    ].join("\n");
  },

  signalExpired(e: ExpiredEvent, timeZone: string): string {
    return [
      `⏱ ${bold(`SIGNAL EXPIRED: ${e.symbol} ${e.side}`)}`,
      "",
      `No TP or SL reached within ${e.hours}h.`,
      `Closed at market: ${formatPrice(e.symbol, e.price)} (${formatPercent(e.resultPercent)})`,
      `Time: ${formatTime(e.at, timeZone)}`,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------------------------------

/** "live" events come from the strategy's own signals. "demo" events come from users' virtual trades. */
export type EventSource = "live" | "demo";

export const MAX_SENT_IDS = 2000;
export const RETRY_EVERY_MS = 5 * 60_000;
export const MAX_RETRIES = 12;
const DAY = 24 * 60 * 60_000;
const DEMO_NOTE = "\n\n<i>Demo trade, virtual money.</i>";

interface SentEntry {
  id: string;
  at: number;
}
export interface FailedEntry {
  key: string;
  kind: string;
  text: string;
  firstFailedAt: number;
  retries: number;
  status: "pending" | "abandoned";
  lastReason: string;
}
export interface TelegramStatus {
  lastSuccessAt: number | null;
  postsLast24h: number;
  failed: number;
  abandoned: number;
}
export interface TelegramResultEntry {
  at: string;
  /** The event id, for example "<trade id>:TP1". */
  signalId: string;
  kind: string;
  result: "sent" | "failed";
  /** Short reason for a failure. Never contains the token or channel id. */
  reason?: string;
}

export interface TelegramNotifierOptions {
  /** The client retries network errors, HTTP 429 and 5xx up to 3 times before it gives up. */
  client: { sendMessage(text: string): Promise<SendResult> };
  /** Read for every message: nothing is sent while this returns false. */
  enabled: () => boolean;
  /** Admin setting postDemoEvents. Demo trade events are sent only while this returns true. Default: off. */
  postDemoEvents?: () => boolean;
  /** Returns false to hold back strategy messages (for example paper signals while an admin has not allowed them). */
  allowLive?: () => boolean;
  /** IANA zone for the times in the messages (default Asia/Riyadh = UTC+3). */
  timeZone?: () => string;
  /** Ids of the events already sent, so a restart never sends them again. */
  sentFile: string;
  /** Messages that could not be sent, retried every 5 minutes. */
  failedFile: string;
  log: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}

/**
 * Posts the events of a trade to the Telegram channel: a new signal, TP1, TP2, TP3, a stop loss, a trade closed after TP1,
 * and an expired signal. Every event is sent once (its id is stored), failures are retried and logged, and nothing here
 * ever throws. The bot token and channel are held by the client, which reads them from the admin settings.
 */
export class TelegramNotifier {
  private sent: SentEntry[];
  private failed: FailedEntry[];
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly recent: TelegramResultEntry[] = [];
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly o: TelegramNotifierOptions) {
    this.now = o.now ?? Date.now;
    const sent = readJson<unknown>(o.sentFile, []);
    const failed = readJson<unknown>(o.failedFile, []);
    this.sent = Array.isArray(sent) ? (sent as SentEntry[]) : [];
    this.failed = Array.isArray(failed) ? (failed as FailedEntry[]) : [];
  }

  private tz(): string {
    return this.o.timeZone?.() ?? "Asia/Riyadh";
  }

  /** Starts the 5-minute retry timer. */
  start(): void {
    this.timer = setInterval(() => void this.retryFailed(), RETRY_EVERY_MS);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- one function per event type -------------------------------------------------------------------------------

  /** A new BUY or SELL signal. */
  newSignal(signal: Signal, source: EventSource = "live"): Promise<void> {
    if (signal.test || (signal.side !== "BUY" && signal.side !== "SELL")) return Promise.resolve();
    return this.deliver(`${signal.id}:SIGNAL`, "signal", source, () => messages.newSignal(signal, this.tz()));
  }
  tp1Hit(tradeId: string, e: Tp1Event, source: EventSource = "live"): Promise<void> {
    return this.deliver(`${tradeId}:TP1`, "TP1", source, () => messages.tp1Hit(e, this.tz()));
  }
  tp2Hit(tradeId: string, e: Tp2Event, source: EventSource = "live"): Promise<void> {
    return this.deliver(`${tradeId}:TP2`, "TP2", source, () => messages.tp2Hit(e, this.tz()));
  }
  tp3Hit(tradeId: string, e: Tp3Event, source: EventSource = "live"): Promise<void> {
    return this.deliver(`${tradeId}:TP3`, "TP3", source, () => messages.tp3Hit(e, this.tz()));
  }
  stopLossHit(tradeId: string, e: StopLossEvent, source: EventSource = "live"): Promise<void> {
    return this.deliver(`${tradeId}:SL`, "SL", source, () => messages.stopLossHit(e, this.tz()));
  }
  closedAfterTp(tradeId: string, e: ClosedAfterTpEvent, source: EventSource = "live"): Promise<void> {
    return this.deliver(`${tradeId}:CLOSED`, "CLOSED", source, () => messages.closedAfterTp(e, this.tz()));
  }
  signalExpired(tradeId: string, e: ExpiredEvent, source: EventSource = "live"): Promise<void> {
    return this.deliver(`${tradeId}:EXPIRED`, "EXPIRED", source, () => messages.signalExpired(e, this.tz()));
  }

  // ---- delivery ---------------------------------------------------------------------------------------------------

  /** Sends one event once, and keeps track of it so `idle()` can wait for it. */
  private deliver(eventId: string, kind: string, source: EventSource, build: () => string): Promise<void> {
    const task = this.deliverNow(eventId, kind, source, build);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }

  /** Resolves when every message handed to the notifier so far has been sent or has failed (a one-shot run waits here before it exits). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Sends one event once. Demo events are dropped unless postDemoEvents is on. Never throws. */
  private async deliverNow(eventId: string, kind: string, source: EventSource, build: () => string): Promise<void> {
    try {
      if (!this.o.enabled()) return;
      if (source === "demo" && !this.o.postDemoEvents?.()) return; // demo events are off unless an admin turned them on
      if (source === "live" && this.o.allowLive && !this.o.allowLive()) return;
      const key = source === "demo" ? `demo:${eventId}` : eventId;
      if (this.wasSent(key) || this.inFlight.has(key) || this.failed.some((f) => f.key === key)) return;

      this.inFlight.add(key);
      try {
        const text = build() + (source === "demo" ? DEMO_NOTE : "");
        const result = await this.send(key, kind, text);
        if (result.ok) this.markSent(key);
        else {
          this.failed.push({ key, kind, text, firstFailedAt: this.now(), retries: 0, status: "pending", lastReason: result.reason });
          this.saveFailed();
        }
      } finally {
        this.inFlight.delete(key);
      }
    } catch (err) {
      this.o.log.error({ err, eventId }, "telegram notification crashed"); // never lets a notification take anything down
    }
  }

  /** Tries every pending failed message again. A message is abandoned after 12 retries. */
  async retryFailed(): Promise<void> {
    try {
      if (!this.o.enabled()) return;
      for (const entry of this.failed.filter((f) => f.status === "pending")) {
        if (this.inFlight.has(entry.key)) continue;
        this.inFlight.add(entry.key);
        try {
          const result = await this.send(entry.key, entry.kind, entry.text);
          if (result.ok) {
            this.failed = this.failed.filter((f) => f !== entry);
            this.markSent(entry.key);
          } else {
            entry.retries += 1;
            entry.lastReason = result.reason;
            if (entry.retries >= MAX_RETRIES) {
              entry.status = "abandoned";
              this.o.log.error({ eventId: entry.key }, "telegram message abandoned after 12 retries");
            }
          }
        } finally {
          this.inFlight.delete(entry.key);
        }
      }
      this.saveFailed();
    } catch (err) {
      this.o.log.error({ err }, "telegram retry crashed");
    }
  }

  status(): TelegramStatus {
    const cutoff = this.now() - DAY;
    return {
      lastSuccessAt: this.sent.length ? Math.max(...this.sent.map((e) => e.at)) : null,
      postsLast24h: this.sent.filter((e) => e.at >= cutoff).length,
      failed: this.failed.length,
      abandoned: this.failed.filter((f) => f.status === "abandoned").length,
    };
  }

  /** The last 20 send attempts, newest last. */
  recentResults(): TelegramResultEntry[] {
    return [...this.recent];
  }

  private async send(key: string, kind: string, text: string): Promise<SendResult> {
    const result = await this.o.client.sendMessage(text);
    this.recent.push({ at: new Date(this.now()).toISOString(), signalId: key, kind, result: result.ok ? "sent" : "failed", ...(result.ok ? {} : { reason: result.reason }) });
    if (this.recent.length > 20) this.recent.shift();
    if (result.ok) this.o.log.info({ eventId: key, result: "sent", messageId: result.messageId }, "telegram post");
    else this.o.log.warn({ eventId: key, result: "failed", reason: result.reason }, "telegram post");
    return result;
  }

  private wasSent(id: string): boolean {
    return this.sent.some((e) => e.id === id);
  }

  private markSent(id: string): void {
    this.sent.push({ id, at: this.now() });
    if (this.sent.length > MAX_SENT_IDS) this.sent = this.sent.slice(-MAX_SENT_IDS);
    try {
      writeJson(this.o.sentFile, this.sent);
    } catch (err) {
      this.o.log.error({ err }, "could not save the sent telegram event ids");
    }
  }

  private saveFailed(): void {
    try {
      writeJson(this.o.failedFile, this.failed);
    } catch (err) {
      this.o.log.error({ err }, "could not save the failed telegram messages");
    }
  }
}

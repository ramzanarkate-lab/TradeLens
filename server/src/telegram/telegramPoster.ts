import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.js";
import type { Signal, StatusChange } from "../types/index.js";
import { formatSignal, formatStatusUpdate } from "./formatSignal.js";
import type { SendResult, TelegramClient } from "./telegramClient.js";

export const MAX_SENT_IDS = 1000;
export const RETRY_EVERY_MS = 5 * 60_000;
export const MAX_RETRIES = 12;
const DAY = 24 * 60 * 60_000;

interface SentEntry {
  id: string;
  at: number;
}

export interface FailedEntry {
  signal: Signal;
  /** Set when this is a status-change message (TP1_HIT, SL_HIT, ...) rather than the new-signal message. */
  change?: StatusChange;
  firstFailedAt: number;
  retries: number;
  status: "pending" | "abandoned";
  lastReason: string;
}

export interface TelegramStatus {
  lastSuccessAt: number | null;
  postsLast24h: number;
  /** Posts that failed after all retries: still waiting for the 5-minute retry, plus abandoned ones. */
  failed: number;
  abandoned: number;
}

export interface TelegramPosterOptions {
  client: Pick<TelegramClient, "sendMessage">;
  /** Read for every post: posting happens only while this returns true. */
  enabled: () => boolean;
  timeZone: () => string;
  /** Strategy numbers shown in the message (EMA periods, RSI period). */
  strategy?: () => { emaFast: number; emaSlow: number; rsiPeriod: number };
  sentFile: string;
  failedFile: string;
  /** Receives one line per attempt (written to logs/telegram.log). Never given the token. */
  log: Pick<Logger, "info" | "warn" | "error">;
  /** Signals created before this time (server start) are never posted. */
  startedAt: number;
  now?: () => number;
}

export interface TelegramResultEntry {
  at: string;
  signalId: string;
  kind: "signal" | string;
  result: "sent" | "failed";
  /** Short reason for a failure. Never contains the token or channel id. */
  reason?: string;
}

/** Id used to post each message once: the signal id, or signal id + status for an update. */
const keyOf = (signal: Signal, change?: StatusChange) => (change ? `${signal.id}:${change.status}` : signal.id);

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

/** Posts each new BUY/SELL signal to the Telegram channel, once, with a failure queue that retries every 5 minutes. */
export class TelegramPoster {
  private sent: SentEntry[];
  private failed: FailedEntry[];
  private readonly inFlight = new Set<string>();
  private readonly recent: TelegramResultEntry[] = [];
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly o: TelegramPosterOptions) {
    this.now = o.now ?? Date.now;
    const sent = readJson<unknown>(o.sentFile, []);
    const failed = readJson<unknown>(o.failedFile, []);
    this.sent = Array.isArray(sent) ? (sent as SentEntry[]) : [];
    this.failed = Array.isArray(failed) ? (failed as FailedEntry[]) : [];
  }

  /** Starts the 5-minute retry timer. */
  start(): void {
    this.timer = setInterval(() => void this.retryFailed(), RETRY_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Call for every signal the engine creates. Safe to call twice for the same signal. */
  async handle(signal: Signal): Promise<void> {
    if (!this.o.enabled()) return;
    if (signal.test) return; // samples from POST /api/alerts/test
    if (signal.mode !== "live") return; // paper signals are never published
    if (signal.side !== "BUY" && signal.side !== "SELL") return;
    if (signal.createdAt < this.o.startedAt) return; // made before this server run: never repost after a restart
    if (this.wasSent(signal.id) || this.inFlight.has(signal.id) || this.failed.some((f) => f.signal.id === signal.id)) return;

    this.inFlight.add(signal.id);
    try {
      const result = await this.post(signal);
      if (result.ok) this.markSent(signal.id);
      else {
        this.failed.push({ signal, firstFailedAt: this.now(), retries: 0, status: "pending", lastReason: result.reason });
        this.saveFailed();
      }
    } finally {
      this.inFlight.delete(signal.id);
    }
  }

  /** Call for every status change. Only TP1_HIT, TP2_HIT, TP3_HIT and SL_HIT of live signals are posted, each once. */
  async handleUpdate(signal: Signal, change: StatusChange): Promise<void> {
    if (!this.o.enabled()) return;
    if (signal.test || signal.mode !== "live") return;
    if (!["TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT"].includes(change.status)) return;
    if (signal.createdAt < this.o.startedAt) return;
    const key = keyOf(signal, change);
    if (this.wasSent(key) || this.inFlight.has(key) || this.failed.some((f) => keyOf(f.signal, f.change) === key)) return;

    this.inFlight.add(key);
    try {
      const result = await this.post(signal, change);
      if (result.ok) this.markSent(key);
      else {
        this.failed.push({ signal, change, firstFailedAt: this.now(), retries: 0, status: "pending", lastReason: result.reason });
        this.saveFailed();
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Tries every pending failed post again. A post is abandoned after 12 retries. */
  async retryFailed(): Promise<void> {
    if (!this.o.enabled()) return;
    for (const entry of this.failed.filter((f) => f.status === "pending")) {
      const key = keyOf(entry.signal, entry.change);
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      try {
        const result = await this.post(entry.signal, entry.change);
        if (result.ok) {
          this.failed = this.failed.filter((f) => f !== entry);
          this.markSent(key);
        } else {
          entry.retries += 1;
          entry.lastReason = result.reason;
          if (entry.retries >= MAX_RETRIES) {
            entry.status = "abandoned";
            this.o.log.error({ signalId: entry.signal.id }, "telegram post abandoned after 12 retries");
          }
        }
      } finally {
        this.inFlight.delete(key);
      }
    }
    this.saveFailed();
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

  private async post(signal: Signal, change?: StatusChange): Promise<SendResult> {
    const opts = { timeZone: this.o.timeZone(), ...this.o.strategy?.() };
    const text = change ? formatStatusUpdate(signal, change, opts) : formatSignal(signal, opts);
    const result = await this.o.client.sendMessage(text);
    this.remember({ at: new Date(this.now()).toISOString(), signalId: signal.id, kind: change ? change.status : "signal", result: result.ok ? "sent" : "failed", ...(result.ok ? {} : { reason: result.reason }) });
    if (result.ok) this.o.log.info({ signalId: signal.id, ...(change ? { status: change.status } : {}), result: "sent", messageId: result.messageId }, "telegram post");
    else this.o.log.warn({ signalId: signal.id, ...(change ? { status: change.status } : {}), result: "failed", reason: result.reason }, "telegram post");
    return result;
  }

  /** The last 20 post attempts, newest last. */
  recentResults(): TelegramResultEntry[] {
    return [...this.recent];
  }

  private remember(e: TelegramResultEntry): void {
    this.recent.push(e);
    if (this.recent.length > 20) this.recent.shift();
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
      this.o.log.error({ err }, "could not save telegram-sent.json");
    }
  }

  private saveFailed(): void {
    try {
      writeJson(this.o.failedFile, this.failed);
    } catch (err) {
      this.o.log.error({ err }, "could not save telegram-failed.json");
    }
  }
}

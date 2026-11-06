import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.js";
import type { Signal, SignalSide, SignalStatus } from "../types/index.js";
import { isActive } from "./lifecycle.js";

/** Old limit, kept for reference. The full history is kept now: nothing is deleted automatically. */
export const MAX_STORED_SIGNALS = Number.POSITIVE_INFINITY;

/** Signals kept in memory and persisted to a JSON file (newest last on disk). The whole history is kept. */
export interface SignalQuery {
  symbol?: string;
  side?: SignalSide;
  status?: SignalStatus;
  /** createdAt range, epoch ms, inclusive. */
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export class SignalStore {
  private signals: Signal[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly max: number = MAX_STORED_SIGNALS,
  ) {}

  /** Loads the file if it exists. A corrupt file is set aside (not overwritten) and the store starts empty. */
  load(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("file does not contain an array");
      this.signals = (parsed as Signal[]).slice(-this.max);
      this.logger.info({ count: this.signals.length, file: this.file }, "signals loaded");
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      this.logger.error({ err, aside }, "signals file unreadable, setting it aside and starting empty");
      renameSync(this.file, aside);
    }
  }

  /** Appends a signal (trimming to the newest `max`) and writes the file. Resolves when it is on disk. */
  add(signal: Signal): Promise<void> {
    this.signals.push(signal);
    if (this.signals.length > this.max) this.signals = this.signals.slice(-this.max);
    return this.persist();
  }

  /** Newest first. */
  list(opts: { symbol?: string; limit?: number } = {}): Signal[] {
    const { symbol, limit = 50 } = opts;
    const out: Signal[] = [];
    for (let i = this.signals.length - 1; i >= 0 && out.length < limit; i--) {
      const s = this.signals[i]!;
      if (!symbol || s.symbol === symbol) out.push(s);
    }
    return out;
  }

  /** Replaces a stored signal (same id) after its status changed, and writes the file. */
  update(signal: Signal): Promise<void> {
    const at = this.signals.findIndex((s) => s.id === signal.id);
    if (at < 0) return Promise.resolve();
    this.signals[at] = signal;
    return this.persist();
  }

  /** Every signal, oldest first. */
  all(): Signal[] {
    return this.signals;
  }

  /** Signals still running (OPEN, TP1_HIT, TP2_HIT) for a symbol. */
  active(symbol?: string): Signal[] {
    return this.signals.filter((s) => isActive(s) && (!symbol || s.symbol === symbol));
  }

  hasActive(symbol: string, side: SignalSide): boolean {
    return this.signals.some((s) => s.symbol === symbol && s.side === side && isActive(s));
  }

  /** Filtered page of the history, newest first. `total` counts all matches, before limit and offset. */
  query(q: SignalQuery = {}): { signals: Signal[]; total: number } {
    const matches: Signal[] = [];
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const s = this.signals[i]!;
      if (q.symbol && s.symbol !== q.symbol) continue;
      if (q.side && s.side !== q.side) continue;
      if (q.status && (s.status ?? "OPEN") !== q.status) continue;
      if (q.from !== undefined && s.createdAt < q.from) continue;
      if (q.to !== undefined && s.createdAt > q.to) continue;
      matches.push(s);
    }
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 50;
    return { signals: matches.slice(offset, offset + limit), total: matches.length };
  }

  get(id: string): Signal | undefined {
    return this.signals.find((s) => s.id === id);
  }

  get size(): number {
    return this.signals.length;
  }

  /** Resolves once all queued writes have finished. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.signals);
    const tmp = `${this.file}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file); // atomic replace: a crash never leaves a half-written file
      })
      .catch((err) => this.logger.error({ err }, "failed to persist signals"));
    return this.writeChain;
  }
}

import type { Logger } from "../logging/logger.js";

export interface WatchedPart {
  name: string;
  /** Epoch ms of the last sign of life. */
  lastActivity(): number;
  restart(reason: string): void;
}

export interface WatchdogOptions {
  parts: WatchedPart[];
  logger: Logger;
  /** Default 60 s. */
  checkEveryMs?: number;
  /** A part with no activity for this long is restarted. Default 5 minutes. */
  staleAfterMs?: number;
  now?: () => number;
}

/** Every minute: restart any part (signal runner, price poller) that has shown no activity for 5 minutes. */
export class Watchdog {
  private timer?: NodeJS.Timeout;
  private readonly restartedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: WatchdogOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => this.check(), this.o.checkEveryMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns the names of the parts it restarted. */
  check(): string[] {
    const stale = this.o.staleAfterMs ?? 5 * 60_000;
    const restarted: string[] = [];
    for (const part of this.o.parts) {
      try {
        // After a restart, give the part a full stale period before judging it again.
        const last = Math.max(part.lastActivity(), this.restartedAt.get(part.name) ?? 0);
        if (this.now() - last < stale) continue;
        this.o.logger.warn({ part: part.name, silentSeconds: Math.round((this.now() - last) / 1000) }, "watchdog: restarting stale part");
        this.restartedAt.set(part.name, this.now());
        part.restart("watchdog: no activity for 5 minutes");
        restarted.push(part.name);
      } catch (err) {
        this.o.logger.error({ part: part.name, err: err instanceof Error ? err.message : String(err) }, "watchdog: restart failed");
      }
    }
    return restarted;
  }
}

import { randomUUID } from "node:crypto";
import pino from "pino";
import type { Logger } from "../logging/logger.js";
import type { Store } from "../storage/store.js";

/*
 * One-shot run of the signal engine (for GitHub Actions): take the lock, restore the data, run ONE pass of the signal runner
 * and of the strategy runner, wait for pending Telegram sends, save the data, release the lock, and exit.
 * The long-running server (src/index.ts) is not touched by any of this.
 */

export const LOCK_KEY = "engine-lock";
/** A lock older than this is treated as left behind by a run that was killed. */
export const LOCK_TTL_MS = 15 * 60_000;
export const LOCKED_MESSAGE = "another run in progress";

/** A signal older than this is not posted: after a long gap a one-shot run must not flood the channel with old signals. */
export const FRESH_SIGNAL_MS = 2 * 3_600_000;
export const isFreshSignal = (createdAt: number, now: number): boolean => now - createdAt <= FRESH_SIGNAL_MS;

/**
 * Telegram posting needs a sent-event store that survives between runs. A GitHub runner starts empty every time, so only the
 * Supabase store keeps it: with STORAGE=file the run still works but posts nothing (it could post the same event again).
 */
export function telegramStoreAllowsPosting(kind: Store["kind"]): { allowed: boolean; reason?: string } {
  return kind === "supabase" ? { allowed: true } : { allowed: false, reason: "STORAGE is not supabase: the sent-event ids would not survive this run, so nothing is posted to Telegram" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------------------------------

interface LockValue {
  owner: string | null;
  expiresAt: number;
  acquiredAt?: string;
  releasedAt?: string;
}

/**
 * A lock kept as one document in the store (the Supabase table kv_store, or a file when STORAGE=file).
 * Reading and then writing is not atomic, so two runs that start in the same second could both think they hold it: after
 * writing, the run reads the lock back and only goes on if it is still the owner. Also give the workflow a `concurrency` group.
 */
export class EngineLock {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = LOCK_TTL_MS,
  ) {}

  /** True if this run now holds the lock, false if another run holds it. */
  async acquire(runId: string): Promise<boolean> {
    const current = (await this.store.get(LOCK_KEY)) as LockValue | undefined;
    if (current?.owner && typeof current.expiresAt === "number" && current.expiresAt > this.now()) return false;
    await this.store.set(LOCK_KEY, { owner: runId, expiresAt: this.now() + this.ttlMs, acquiredAt: new Date(this.now()).toISOString() } satisfies LockValue);
    const after = (await this.store.get(LOCK_KEY)) as LockValue | undefined;
    return after?.owner === runId;
  }

  /** Releases the lock, but only if this run still owns it. */
  async release(runId: string): Promise<void> {
    const current = (await this.store.get(LOCK_KEY)) as LockValue | undefined;
    if (current?.owner !== runId) return;
    await this.store.set(LOCK_KEY, { owner: null, expiresAt: 0, releasedAt: new Date(this.now()).toISOString() } satisfies LockValue);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Masking: no key, token or channel id ever reaches a log
// ---------------------------------------------------------------------------------------------------------------------

const PATTERNS: Array<[RegExp, string]> = [
  [/\/bot[^/\s"'\\]+/g, "/bot<redacted>"], // a Telegram API address
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,50}\b/g, "<telegram-token>"],
  [/-100\d{5,}/g, "<channel-id>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "<jwt>"], // Supabase keys are JWTs
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, "<supabase-key>"],
  [/((?:apikey|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi, "$1<redacted>"],
];

/** Replaces every given secret value, and anything shaped like a token, key or channel id, in the text. */
export function maskSecrets(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("<redacted>");
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** The secret values of an environment: these are masked wherever they appear. */
export function secretValues(env: Partial<Record<string, string | undefined>>): string[] {
  return ["SUPABASE_SERVICE_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID", "JWT_SECRET", "BINANCE_API_KEY", "BINANCE_API_SECRET"].map((k) => env[k]).filter((v): v is string => Boolean(v));
}

/** A logger whose every line is masked before it is written, whatever the code logging it did. */
export function createMaskedLogger(level: string, secrets: ReadonlyArray<string | undefined>, write: (line: string) => void = (line) => void process.stdout.write(line)): Logger {
  return pino({ level }, { write: (line: string) => write(maskSecrets(line, secrets)) });
}

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

export interface OnceSteps {
  /** Restores the data folder from the store. Nothing is saved back if this fails. */
  hydrate(): Promise<void>;
  /** One pass of the signal runner and of the strategy runner. */
  run(): Promise<void>;
  /** Waits for pending Telegram sends and saves the data. */
  settle(): Promise<void>;
}

export interface OnceDeps {
  /** Where the lock lives. */
  store: Store;
  steps: OnceSteps;
  logger: Pick<Logger, "info" | "warn" | "error">;
  runId?: string;
  now?: () => number;
  lockTtlMs?: number;
}

export interface OnceResult {
  /** 0 on success (also when another run holds the lock), 1 on error. */
  exitCode: 0 | 1;
  status: "done" | "locked" | "failed";
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runOnce(d: OnceDeps): Promise<OnceResult> {
  const runId = d.runId ?? randomUUID();
  const lock = new EngineLock(d.store, d.now, d.lockTtlMs);

  let acquired: boolean;
  try {
    acquired = await lock.acquire(runId);
  } catch (err) {
    d.logger.error({ err: message(err) }, "could not take the run lock");
    return { exitCode: 1, status: "failed" };
  }
  if (!acquired) {
    d.logger.info(LOCKED_MESSAGE); // nothing was read or written: the other run owns the data
    return { exitCode: 0, status: "locked" };
  }

  let failed = false;
  let hydrated = false;
  try {
    await d.steps.hydrate();
    hydrated = true;
    await d.steps.run();
  } catch (err) {
    failed = true;
    d.logger.error({ err: message(err) }, hydrated ? "engine run failed" : "could not restore the data: nothing was run and nothing will be saved");
  }
  if (hydrated) {
    try {
      await d.steps.settle(); // pending Telegram sends first, then the data is saved, even after a failed run
    } catch (err) {
      failed = true;
      d.logger.error({ err: message(err) }, "could not finish saving");
    }
  }
  try {
    await lock.release(runId);
  } catch (err) {
    d.logger.warn({ err: message(err) }, "could not release the run lock (it expires on its own)");
  }
  d.logger.info({ status: failed ? "failed" : "done" }, "engine run finished");
  return failed ? { exitCode: 1, status: "failed" } : { exitCode: 0, status: "done" };
}

/** Where TradeLens documents live. Keys look like "signals" or "backtests/BTCUSDT-2026-11-06"; values are JSON. */
export interface Store {
  readonly kind: "file" | "supabase";
  /** The stored value, or undefined if the key does not exist. */
  get(key: string): Promise<unknown | undefined>;
  /** Creates or replaces the value. Writes to the same key happen one at a time, in call order. */
  set(key: string, value: unknown): Promise<void>;
  /** Every key that starts with the prefix (all keys if none is given), sorted. */
  list(prefix?: string): Promise<string[]>;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Keys become file names and URL parts, so only plain segments are allowed (no "..", no leading slash). */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
}

/** Runs tasks for the same key one after another, so two writes never interleave. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

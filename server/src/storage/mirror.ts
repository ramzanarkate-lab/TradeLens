import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../logging/logger.js";
import type { Store } from "./store.js";

export interface FileMirrorOptions {
  store: Store;
  /** The data folder the server reads and writes (DATA_DIR). */
  dir: string;
  /** Documents kept in the store, e.g. "signals" (the file is DATA_DIR/signals.json). */
  keys: string[];
  /** Folders whose *.json files are kept too, e.g. "backtests". */
  folders?: string[];
  logger: Logger;
  intervalMs?: number;
}

/**
 * Hosts like Render's free plan wipe the disk on every restart. This keeps the data folder in the store:
 * on start it copies the stored documents down BEFORE the server reads them, and afterwards it copies every
 * changed file up (every 10 seconds, and once more at shutdown). The server's own stores keep working on files.
 */
export class FileMirror {
  private readonly pushed = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly o: FileMirrorOptions) {}

  private file(key: string): string {
    return join(this.o.dir, `${key}.json`);
  }

  /** Throws if the store cannot be read: starting with an empty folder could later overwrite good stored data. */
  async hydrate(): Promise<number> {
    const keys = new Set(this.o.keys);
    for (const folder of this.o.folders ?? []) for (const k of await this.o.store.list(`${folder}/`)) keys.add(k);
    let count = 0;
    for (const key of keys) {
      const value = await this.o.store.get(key);
      if (value === undefined) continue;
      const text = JSON.stringify(value);
      mkdirSync(dirname(this.file(key)), { recursive: true });
      writeFileSync(`${this.file(key)}.tmp`, text);
      renameSync(`${this.file(key)}.tmp`, this.file(key));
      this.pushed.set(key, text);
      count++;
    }
    this.o.logger.info({ documents: count }, "data restored from storage");
    return count;
  }

  start(): void {
    this.timer = setInterval(() => void this.push(), this.o.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private currentKeys(): string[] {
    const keys = [...this.o.keys];
    for (const folder of this.o.folders ?? []) {
      const dir = join(this.o.dir, folder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) if (name.endsWith(".json")) keys.push(`${folder}/${name.slice(0, -5)}`);
    }
    return keys;
  }

  /** Uploads every file whose content changed since the last upload. A failure is logged and retried next time. */
  async push(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const key of this.currentKeys()) {
        const file = this.file(key);
        if (!existsSync(file)) continue;
        let text: string;
        try {
          text = readFileSync(file, "utf8");
          JSON.parse(text);
        } catch {
          continue; // half-written or not JSON: try again next round
        }
        if (this.pushed.get(key) === text) continue;
        try {
          await this.o.store.set(key, JSON.parse(text));
          this.pushed.set(key, text);
        } catch (err) {
          this.o.logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, "could not save to storage, will retry");
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Final upload at shutdown. */
  async flush(): Promise<void> {
    this.stop();
    await this.push();
  }
}

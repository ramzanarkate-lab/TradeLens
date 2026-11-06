import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeKey, KeyedQueue, type Store } from "./store.js";

/** Local development: one JSON file per key under the data folder (key "a/b" is DATA_DIR/a/b.json). */
export class FileStore implements Store {
  readonly kind = "file" as const;
  private readonly queue = new KeyedQueue();

  constructor(private readonly dir: string) {}

  private path(key: string): string {
    assertSafeKey(key);
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<unknown | undefined> {
    const file = this.path(key);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  }

  async set(key: string, value: unknown): Promise<void> {
    const file = this.path(key);
    return await this.queue.run(key, async () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(value));
      renameSync(`${file}.tmp`, file);
    });
  }

  async list(prefix = ""): Promise<string[]> {
    const out: string[] = [];
    const walk = (folder: string, base: string) => {
      if (!existsSync(folder)) return;
      for (const name of readdirSync(folder)) {
        const full = join(folder, name);
        if (statSync(full).isDirectory()) walk(full, `${base}${name}/`);
        else if (name.endsWith(".json")) out.push(`${base}${name.slice(0, -5)}`);
      }
    };
    walk(this.dir, "");
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
}

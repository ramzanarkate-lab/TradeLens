import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.js";

/** A signed-in account, as kept in data/users.json. The role is NOT stored: it is computed on every request. */
export interface UserRecord {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  lastLoginAt: number;
}

export interface Profile {
  id: string;
  email: string;
  name: string;
}

/** Users kept in memory and persisted to a JSON file (atomic writes). */
export class UserStore {
  private users = new Map<string, UserRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Loads the file if present. A corrupt file is set aside, never overwritten. */
  load(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("file does not contain an array");
      for (const u of parsed as UserRecord[]) {
        if (typeof u?.id === "string") {
          const { pro: _legacyPro, ...rest } = u as UserRecord & { pro?: unknown }; // older files carried a "pro" flag
          this.users.set(u.id, rest);
        }
      }
      this.logger.info({ count: this.users.size }, "users loaded");
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      this.logger.error({ err, aside }, "users file unreadable, setting it aside and starting empty");
      renameSync(this.file, aside);
    }
  }

  get(id: string): UserRecord | undefined {
    const u = this.users.get(id);
    return u ? { ...u } : undefined;
  }

  get size(): number {
    return this.users.size;
  }

  /** Creates the user on first sign-in, otherwise refreshes name, email and lastLoginAt. */
  upsertOnLogin(profile: Profile): UserRecord {
    const now = this.now();
    const existing = this.users.get(profile.id);
    const record: UserRecord = existing
      ? { ...existing, email: profile.email, name: profile.name, lastLoginAt: now }
      : { id: profile.id, email: profile.email, name: profile.name, createdAt: now, lastLoginAt: now };
    this.users.set(record.id, record);
    void this.persist();
    return { ...record };
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.users.values()], null, 2);
    const tmp = `${this.file}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file);
      })
      .catch((err) => this.logger.error({ err }, "failed to persist users"));
    return this.writeChain;
  }
}

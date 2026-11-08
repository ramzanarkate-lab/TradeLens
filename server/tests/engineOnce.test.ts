import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logging/logger.js";
import {
  createMaskedLogger,
  EngineLock,
  FRESH_SIGNAL_MS,
  isFreshSignal,
  LOCK_KEY,
  LOCK_TTL_MS,
  LOCKED_MESSAGE,
  maskSecrets,
  runOnce,
  secretValues,
  telegramStoreAllowsPosting,
  type OnceSteps,
} from "../src/runner/engineOnce.js";
import { createOnceSteps } from "../src/runner/onceWiring.js";
import { parseEnv } from "../src/config/env.js";
import { FileStore } from "../src/storage/fileStore.js";
import { SupabaseStore } from "../src/storage/supabaseStore.js";
import type { Store } from "../src/storage/store.js";
import { TelegramNotifier } from "../src/telegram/telegramNotifier.js";

const silent = createLogger({ level: "silent", pretty: false });

const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl";
const BOT_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghij123456";
const CHANNEL = "-1001234567890";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-once-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

class MemStore implements Store {
  readonly kind = "supabase" as const;
  readonly data = new Map<string, unknown>();
  async get(key: string) {
    return this.data.get(key);
  }
  async set(key: string, value: unknown) {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async list() {
    return [...this.data.keys()];
  }
}

describe("the run lock", () => {
  it("is taken by the first run and refused to a second one", async () => {
    const store = new MemStore();
    expect(await new EngineLock(store).acquire("a")).toBe(true);
    expect(await new EngineLock(store).acquire("b")).toBe(false);
  });

  it("can be taken again after the owner released it", async () => {
    const store = new MemStore();
    const lock = new EngineLock(store);
    await lock.acquire("a");
    await lock.release("a");
    expect(await lock.acquire("b")).toBe(true);
  });

  it("only the owner can release it", async () => {
    const store = new MemStore();
    const lock = new EngineLock(store);
    await lock.acquire("a");
    await lock.release("b");
    expect(await lock.acquire("c")).toBe(false); // still held by a
  });

  it("a lock left behind by a killed run expires after 15 minutes", async () => {
    let now = 1_000_000;
    const store = new MemStore();
    const lock = new EngineLock(store, () => now);
    await lock.acquire("a");
    now += LOCK_TTL_MS - 1;
    expect(await lock.acquire("b")).toBe(false);
    now += 2;
    expect(await lock.acquire("b")).toBe(true);
  });

  it("goes on only if it is still the owner when it reads the lock back", async () => {
    const racing = new MemStore();
    const realSet = racing.set.bind(racing);
    racing.set = async (key, value) => {
      await realSet(key, { owner: "someone-else", expiresAt: Date.now() + 60_000 }); // another run wrote at the same moment
      void value;
    };
    expect(await new EngineLock(racing).acquire("me")).toBe(false);
  });

  it("works with the file store too (STORAGE=file)", async () => {
    const store = new FileStore(dir);
    expect(await new EngineLock(store).acquire("a")).toBe(true);
    expect(await new EngineLock(store).acquire("b")).toBe(false);
    expect(await store.get(LOCK_KEY)).toMatchObject({ owner: "a" });
    await new EngineLock(store).release("a");
    expect(await new EngineLock(store).acquire("b")).toBe(true);
  });
});

describe("runOnce", () => {
  function steps(over: Partial<OnceSteps> = {}, calls: string[] = []) {
    const s: OnceSteps = {
      hydrate: vi.fn(async () => void calls.push("hydrate")),
      run: vi.fn(async () => void calls.push("run")),
      settle: vi.fn(async () => void calls.push("settle")),
      ...over,
    };
    return { s, calls };
  }
  const logs = () => {
    const lines: string[] = [];
    const logger = { info: vi.fn((...a: unknown[]) => void lines.push(String(a.at(-1)))), warn: vi.fn(), error: vi.fn((...a: unknown[]) => void lines.push(String(a.at(-1)))) };
    return { logger, lines };
  };

  it("takes the lock, restores the data, runs one cycle, settles, releases, and exits 0", async () => {
    const store = new MemStore();
    const { s, calls } = steps({ run: vi.fn(async () => void calls.push(`run (locked: ${(await store.get(LOCK_KEY) as { owner: string | null }).owner !== null})`)) });
    const { logger } = logs();
    const result = await runOnce({ store, steps: s, logger });
    expect(result).toEqual({ exitCode: 0, status: "done" });
    expect(calls).toEqual(["hydrate", "run (locked: true)", "settle"]);
    expect((await store.get(LOCK_KEY) as { owner: string | null }).owner).toBeNull(); // released
  });

  it('exits 0 with "another run in progress" and touches nothing when the lock is held', async () => {
    const store = new MemStore();
    await new EngineLock(store).acquire("other");
    const { s } = steps();
    const { logger, lines } = logs();
    const result = await runOnce({ store, steps: s, logger });
    expect(result).toEqual({ exitCode: 0, status: "locked" });
    expect(lines).toContain(LOCKED_MESSAGE);
    expect(LOCKED_MESSAGE).toBe("another run in progress");
    expect(s.hydrate).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
    expect(s.settle).not.toHaveBeenCalled(); // the other run owns the data: nothing is read or saved
  });

  it("exits 1 when the cycle fails, but still waits for Telegram, saves and releases the lock", async () => {
    const store = new MemStore();
    const { s, calls } = steps({ run: vi.fn(async () => { throw new Error("market data down"); }) });
    const { logger } = logs();
    const result = await runOnce({ store, steps: s, logger });
    expect(result).toEqual({ exitCode: 1, status: "failed" });
    expect(calls).toEqual(["hydrate", "settle"]);
    expect((await store.get(LOCK_KEY) as { owner: string | null }).owner).toBeNull();
  });

  it("exits 1 and saves nothing when the data cannot be restored (an empty folder must never overwrite good data)", async () => {
    const store = new MemStore();
    const { s } = steps({ hydrate: vi.fn(async () => { throw new Error("Supabase request failed with HTTP 500"); }) });
    const { logger } = logs();
    const result = await runOnce({ store, steps: s, logger });
    expect(result.exitCode).toBe(1);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.settle).not.toHaveBeenCalled();
    expect((await store.get(LOCK_KEY) as { owner: string | null }).owner).toBeNull();
  });

  it("exits 1 when saving fails, and 1 when the lock cannot be taken at all", async () => {
    const { logger } = logs();
    expect((await runOnce({ store: new MemStore(), steps: steps({ settle: vi.fn(async () => { throw new Error("x"); }) }).s, logger })).exitCode).toBe(1);
    const broken = new MemStore();
    broken.get = async () => { throw new Error("Supabase request failed with HTTP 401"); };
    const result = await runOnce({ store: broken, steps: steps().s, logger });
    expect(result).toEqual({ exitCode: 1, status: "failed" });
  });
});

describe("no secret in any log", () => {
  it("masks the Supabase key, the bot token and the channel id wherever they appear", () => {
    const text = `failed: ${SUPABASE_KEY} https://api.telegram.org/bot${BOT_TOKEN}/sendMessage chat ${CHANNEL} apikey: ${SUPABASE_KEY} Authorization: Bearer ${SUPABASE_KEY}`;
    const masked = maskSecrets(text, [SUPABASE_KEY, BOT_TOKEN, CHANNEL]);
    for (const secret of [SUPABASE_KEY, BOT_TOKEN, CHANNEL, "AAFakeToken", "1234567890", "c2lnbmF0dXJl"]) expect(masked).not.toContain(secret);
  });

  it("masks things that only look like secrets, even when their values are not known", () => {
    const masked = maskSecrets(`token ${BOT_TOKEN} channel ${CHANNEL} key ${SUPABASE_KEY}`);
    expect(masked).not.toContain("AAFakeToken");
    expect(masked).not.toContain(CHANNEL);
    expect(masked).not.toContain("eyJhbGci");
  });

  it("the logger masks every line, including an error that carries a secret", () => {
    const written: string[] = [];
    const log = createMaskedLogger("info", [SUPABASE_KEY, BOT_TOKEN, CHANNEL], (line) => written.push(line));
    log.error({ err: new Error(`request to https://x.supabase.co with key ${SUPABASE_KEY} and https://api.telegram.org/bot${BOT_TOKEN}/getMe chat_id ${CHANNEL}`) }, `could not post for ${CHANNEL}`);
    log.info({ headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }, "request");
    const out = written.join("");
    expect(out.length).toBeGreaterThan(0);
    for (const secret of [SUPABASE_KEY, BOT_TOKEN, CHANNEL, "AAFakeToken"]) expect(out).not.toContain(secret);
  });

  it("takes the secret values from the environment (names only are documented)", () => {
    expect(secretValues({ SUPABASE_SERVICE_KEY: "k1", TELEGRAM_BOT_TOKEN: "t1", TELEGRAM_CHANNEL_ID: "c1", PORT: "4000" })).toEqual(["k1", "t1", "c1"]);
  });

  it("a failing Supabase call reports only the status, never the key or the address", async () => {
    const store = new SupabaseStore({ url: "https://project.supabase.co", serviceKey: SUPABASE_KEY, fetchFn: (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch });
    const err = await store.get("signals").catch((e: Error) => e);
    expect((err as Error).message).toBe("Supabase request failed with HTTP 401");
    expect((err as Error).message).not.toContain(SUPABASE_KEY);
  });
});

describe("Telegram on the run-once path", () => {
  it("posts only when the sent-event store survives between runs (Supabase)", () => {
    expect(telegramStoreAllowsPosting("supabase")).toEqual({ allowed: true });
    expect(telegramStoreAllowsPosting("file").allowed).toBe(false);
    expect(telegramStoreAllowsPosting("file").reason).toContain("nothing is posted");
  });

  it("only fresh signals are posted: a signal older than 2 hours is not", () => {
    expect(isFreshSignal(1_000_000, 1_000_000 + FRESH_SIGNAL_MS)).toBe(true);
    expect(isFreshSignal(1_000_000, 1_000_000 + FRESH_SIGNAL_MS + 1)).toBe(false);
  });

  const event = { symbol: "BTCUSDT", side: "BUY" as const, price: 64_900, entry: 64_250, at: 1_000 };
  function notifier(send: (text: string) => Promise<{ ok: true; messageId: number }>) {
    return new TelegramNotifier({ client: { sendMessage: send }, enabled: () => true, sentFile: join(dir, "sent.json"), failedFile: join(dir, "failed.json"), log: silent });
  }

  it("waits for a send that is still in flight before the run exits", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let done = false;
    const n = notifier(async () => {
      await gate;
      done = true;
      return { ok: true as const, messageId: 1 };
    });
    void n.tp1Hit("t1", event);
    const idle = n.idle();
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await idle;
    expect(done).toBe(true);
  });

  it("a second run cannot post an event the first run already posted", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const first = notifier(send);
    await first.tp1Hit("t1", event);
    await first.idle();
    expect(send).toHaveBeenCalledTimes(1);

    const secondRun = notifier(send); // a new process: the ledger file (kept in Supabase between runs) is read again
    await secondRun.tp1Hit("t1", event);
    await secondRun.tp1Hit("t1", event);
    await secondRun.idle();
    expect(send).toHaveBeenCalledTimes(1);
    await secondRun.tp1Hit("t2", event); // a different trade is a different event
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("two events handed over at the same moment are still sent once each", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const n = notifier(send);
    void n.tp1Hit("t1", event);
    void n.tp1Hit("t1", event);
    await n.idle();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("createOnceSteps", () => {
  it("refuses DEMO_MODE (there is no live data to run on)", () => {
    const env = parseEnv({ NODE_ENV: "test", DEMO_MODE: "true", DATA_DIR: dir }, { skipAuthCheck: true });
    expect(() => createOnceSteps(env, new MemStore(), silent)).toThrow(/DEMO_MODE/);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvError, parseEnv } from "../src/config/env.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { createStore, FileMirror, FileStore, SupabaseStore } from "../src/storage/index.js";
import { assertSafeKey, KeyedQueue, type Store } from "../src/storage/store.js";

const silent = createLogger({ level: "silent", pretty: false });
const SERVICE_KEY = "sb_service_key_ABC123_never_log_me";
const URL_ = "https://abcd.supabase.co";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-storage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("FileStore", () => {
  it("stores, reads and lists JSON documents under the data folder", async () => {
    const s = new FileStore(dir);
    expect(await s.get("signals")).toBeUndefined();
    await s.set("signals", [{ id: 1 }]);
    await s.set("backtests/BTCUSDT-2026-11-06", { verdict: "FAIL" });
    expect(await s.get("signals")).toEqual([{ id: 1 }]);
    expect(JSON.parse(readFileSync(join(dir, "signals.json"), "utf8"))).toEqual([{ id: 1 }]);
    expect(await s.list()).toEqual(["backtests/BTCUSDT-2026-11-06", "signals"]);
    expect(await s.list("backtests/")).toEqual(["backtests/BTCUSDT-2026-11-06"]);
  });

  it("rejects keys that could leave the data folder", async () => {
    const s = new FileStore(dir);
    for (const bad of ["../x", "/etc/passwd", "a/../b", "", "a b", "a\\b"]) await expect(s.set(bad, 1)).rejects.toThrow(/Invalid storage key/);
    expect(() => assertSafeKey("settings")).not.toThrow();
  });
});

describe("serialized writes per key", () => {
  it("runs writes to one key in call order, one at a time, while other keys run in parallel", async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string, ms: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      running--;
    };
    await Promise.all([q.run("a", task("a1", 30)), q.run("a", task("a2", 1)), q.run("a", task("a3", 1))]);
    expect(log).toEqual(["start a1", "end a1", "start a2", "end a2", "start a3", "end a3"]);
    expect(maxRunning).toBe(1);
    maxRunning = 0;
    await Promise.all([q.run("x", task("x", 20)), q.run("y", task("y", 20))]);
    expect(maxRunning).toBe(2);
  });

  it("a failed write does not block the next one", async () => {
    const q = new KeyedQueue();
    await expect(q.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(q.run("k", async () => "fine")).resolves.toBe("fine");
  });
});

describe("SupabaseStore (mocked fetch)", () => {
  function mock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch;
    return { calls, store: new SupabaseStore({ url: `${URL_}/`, serviceKey: SERVICE_KEY, fetchFn, now: () => Date.UTC(2026, 10, 6) }) };
  }

  it("reads one document with the key in both auth headers", async () => {
    const { calls, store } = mock(() => new Response(JSON.stringify([{ value: { a: 1 } }]), { status: 200 }));
    expect(await store.get("settings")).toEqual({ a: 1 });
    expect(calls[0]!.url).toBe(`${URL_}/rest/v1/kv_store?key=eq.settings&select=value`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe(SERVICE_KEY);
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
  });

  it("a missing key is undefined", async () => {
    const { store } = mock(() => new Response("[]", { status: 200 }));
    expect(await store.get("nope")).toBeUndefined();
  });

  it("writes with an upsert on the key", async () => {
    const { calls, store } = mock(() => new Response(null, { status: 201 }));
    await store.set("signals", [1, 2]);
    expect(calls[0]!.url).toBe(`${URL_}/rest/v1/kv_store?on_conflict=key`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Prefer).toContain("merge-duplicates");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ key: "signals", value: [1, 2], updated_at: "2026-11-06T00:00:00.000Z" });
  });

  it("lists keys, with an optional prefix", async () => {
    const { calls, store } = mock(() => new Response(JSON.stringify([{ key: "backtests/a" }, { key: "backtests/b" }]), { status: 200 }));
    expect(await store.list("backtests/")).toEqual(["backtests/a", "backtests/b"]);
    expect(calls[0]!.url).toContain("key=like.backtests%2F*");
  });

  it("two writes to one key never overlap", async () => {
    let inFlight = 0;
    let max = 0;
    const { store } = mock(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return new Response(null, { status: 201 });
    });
    await Promise.all([store.set("k", 1), store.set("k", 2), store.set("k", 3)]);
    expect(max).toBe(1);
  });

  it("an error names only the HTTP status: no key, url or response text", async () => {
    const { store } = mock(() => new Response(`{"message":"bad ${SERVICE_KEY}"}`, { status: 401 }));
    const err = await store.get("settings").catch((e: Error) => e);
    expect((err as Error).message).toBe("Supabase request failed with HTTP 401");
    expect((err as Error).message).not.toContain(SERVICE_KEY);
  });
});

describe("choosing the store", () => {
  const base = { NODE_ENV: "test" };

  it("STORAGE defaults to file and createStore returns a FileStore", () => {
    const env = parseEnv(base);
    expect(env.STORAGE).toBe("file");
    expect(createStore({ ...env, DATA_DIR: dir })).toBeInstanceOf(FileStore);
  });

  it("STORAGE=supabase returns a SupabaseStore", () => {
    const env = parseEnv({ ...base, STORAGE: "supabase", SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: SERVICE_KEY });
    expect(createStore(env)).toBeInstanceOf(SupabaseStore);
  });

  it("refuses to start when a Supabase variable is missing, and says which one", () => {
    expect(() => parseEnv({ ...base, STORAGE: "supabase", SUPABASE_SERVICE_KEY: "k" })).toThrow(/SUPABASE_URL is required when STORAGE=supabase/);
    expect(() => parseEnv({ ...base, STORAGE: "supabase", SUPABASE_URL: URL_ })).toThrow(/SUPABASE_SERVICE_KEY is required when STORAGE=supabase/);
    try {
      parseEnv({ ...base, STORAGE: "supabase" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).message).toContain("SUPABASE_URL");
      expect((e as EnvError).message).toContain("SUPABASE_SERVICE_KEY");
    }
    expect(() => parseEnv({ ...base, STORAGE: "ftp" })).toThrow(EnvError);
  });

  it("an error message never prints a secret value", () => {
    try {
      parseEnv({ ...base, STORAGE: "supabase", SUPABASE_SERVICE_KEY: SERVICE_KEY });
    } catch (e) {
      expect((e as Error).message).not.toContain(SERVICE_KEY);
    }
  });
});

describe("FileMirror: the data folder survives a wiped disk", () => {
  /** An in-memory stand-in for Supabase. */
  const memory = (): Store & { data: Map<string, unknown> } => {
    const data = new Map<string, unknown>();
    return {
      kind: "supabase",
      data,
      get: async (k) => data.get(k),
      set: async (k, v) => void data.set(k, v),
      list: async (p = "") => [...data.keys()].filter((k) => k.startsWith(p)).sort(),
    };
  };

  it("restores stored documents before the server reads them, and uploads only what changed", async () => {
    const store = memory();
    store.data.set("signals", [{ id: "s1" }]);
    store.data.set("backtests/BTCUSDT-x", { verdict: "PASS" });
    const set = vi.spyOn(store, "set");
    const mirror = new FileMirror({ store, dir, keys: ["signals", "settings"], folders: ["backtests"], logger: silent });
    expect(await mirror.hydrate()).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, "signals.json"), "utf8"))).toEqual([{ id: "s1" }]);
    expect(existsSync(join(dir, "settings.json"))).toBe(false); // nothing stored yet
    expect(JSON.parse(readFileSync(join(dir, "backtests", "BTCUSDT-x.json"), "utf8"))).toEqual({ verdict: "PASS" });

    await mirror.push();
    expect(set).not.toHaveBeenCalled(); // nothing changed since the restore

    writeFileSync(join(dir, "signals.json"), JSON.stringify([{ id: "s1" }, { id: "s2" }]));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ signals: { minScore: 70 } }));
    await mirror.push();
    expect(set).toHaveBeenCalledTimes(2);
    expect(store.data.get("signals")).toEqual([{ id: "s1" }, { id: "s2" }]);
    await mirror.push();
    expect(set).toHaveBeenCalledTimes(2); // unchanged files are not uploaded again
  });

  it("refuses to start (hydrate throws) when the store cannot be read", async () => {
    const store = memory();
    store.get = async () => Promise.reject(new Error("Supabase request failed with HTTP 503"));
    await expect(new FileMirror({ store, dir, keys: ["signals"], logger: silent }).hydrate()).rejects.toThrow(/HTTP 503/);
  });

  it("a failed upload is retried on the next round", async () => {
    const store = memory();
    const mirror = new FileMirror({ store, dir, keys: ["signals"], logger: silent });
    writeFileSync(join(dir, "signals.json"), "[1]");
    let fail = true;
    const real = store.set;
    store.set = async (k, v) => {
      if (fail) throw new Error("network down");
      return real(k, v);
    };
    await mirror.push();
    expect(store.data.size).toBe(0);
    fail = false;
    await mirror.push();
    expect(store.data.get("signals")).toEqual([1]);
  });
});

describe("GET and HEAD /health", () => {
  it("answers both without a login and shows no secret", async () => {
    const app = createApp({
      env: { CORS_ORIGINS: [] },
      logger: silent,
      clientCount: () => 0,
      marketHealth: () => ({ status: "Live", provider: "bybit", lastPoll: {}, reason: null }),
      healthExtra: () => ({ runnerStatus: "running", telegramStatus: "not configured", storage: "supabase" }),
    });
    const get = await request(app).get("/health").expect(200);
    expect(get.body).toMatchObject({ status: "ok", activeProvider: "bybit", runnerStatus: "running", telegramStatus: "not configured", storage: "supabase" });
    expect(typeof get.body.uptime).toBe("number");
    await request(app).head("/health").expect(200);
    const text = JSON.stringify(get.body);
    expect(text).not.toContain(SERVICE_KEY);
    expect(text).not.toMatch(/token|secret|key/i);
  });
});

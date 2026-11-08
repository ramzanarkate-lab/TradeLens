import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { StaticSignalSettings } from "../src/signals/settingsProvider.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { installProcessGuards } from "../src/runner/processGuards.js";
import { SignalRunner } from "../src/runner/signalRunner.js";
import { Watchdog } from "../src/runner/watchdog.js";
import type { Candle } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 10);
const candle = (time: number, closed: boolean): Candle => ({ time, open: 1, high: 2, low: 1, close: 1.5, volume: 1, closed });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-runner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function setup(opts: { candles: () => Candle[]; settings?: Partial<ConstructorParameters<typeof StaticSignalSettings>[0]> } ) {
  const service = { processHour: vi.fn(async (_s: string, _r?: boolean) => null as never), checkPrice: vi.fn() };
  const market = { getFreshCandles: vi.fn(async () => opts.candles()) };
  const make = () =>
    new SignalRunner({
      service: service as never,
      market,
      settings: new StaticSignalSettings({ enabledSymbols: ["BTCUSDT"], triggerTimeframe: "1h", ...opts.settings }),
      logger: silent,
      stateFile: join(dir, "runner-state.json"),
    });
  return { service, market, make };
}

describe("signal runner", () => {
  it("evaluates a newly closed candle exactly once", async () => {
    let candles = [candle(T0 - HOUR, true), candle(T0, false)];
    const { service, make } = setup({ candles: () => candles });
    const runner = make();
    await runner.tick(); // the first look after a start: the newest closed candle is evaluated once
    expect(service.processHour).toHaveBeenCalledTimes(1);
    await runner.tick();
    expect(service.processHour).toHaveBeenCalledTimes(1); // the same candle is not evaluated again

    candles = [candle(T0, true), candle(T0 + HOUR, false)]; // T0 has now closed
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(service.processHour).toHaveBeenCalledTimes(2); // one more evaluation for the one new closed candle
    expect(service.processHour).toHaveBeenCalledWith("BTCUSDT", true);
  });

  it("never evaluates a forming candle", async () => {
    let candles = [candle(T0 - HOUR, true), candle(T0, false)];
    const { service, make } = setup({ candles: () => candles });
    const runner = make();
    await runner.tick();
    candles = [candle(T0 - HOUR, true), candle(T0, false)];
    await runner.tick();
    expect(service.processHour).toHaveBeenCalledTimes(1); // only the closed candle (T0 - 1h), once; the forming T0 is never evaluated
    expect(runner.lastCandleTimes().BTCUSDT).toBe(new Date(T0 - HOUR).toISOString());
  });

  it("a restart does not repeat work already done (state is on disk)", async () => {
    let candles = [candle(T0 - HOUR, true)];
    const first = setup({ candles: () => candles });
    const r1 = first.make();
    await r1.tick();
    candles = [candle(T0, true)];
    await r1.tick();
    expect(first.service.processHour).toHaveBeenCalledTimes(2); // the first look, then the new candle
    expect(JSON.parse(readFileSync(join(dir, "runner-state.json"), "utf8"))).toEqual({ "BTCUSDT:1h": T0 });

    const r2 = first.make(); // "restart": a new runner reading the same state file
    await r2.tick();
    await r2.tick();
    await r2.tick();
    // its first look re-checks the newest candle once (the service never makes a second signal from a candle); nothing else repeats
    expect(first.service.processHour).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(join(dir, "runner-state.json"), "utf8"))).toEqual({ "BTCUSDT:1h": T0 });
  });

  it("a failed evaluation (network down) is retried on the next pass, then resumes", async () => {
    let candles = [candle(T0 - HOUR, true)];
    const { service, make } = setup({ candles: () => candles });
    const runner = make();
    await runner.tick(); // first look: 1 call
    candles = [candle(T0, true)];
    service.processHour.mockRejectedValueOnce(new Error("network down"));
    await runner.tick(); // the new candle: fails
    expect(runner.events().some((e) => e.type === "error" && /network down/.test(e.detail))).toBe(true);
    await runner.tick(); // retried and works
    expect(service.processHour).toHaveBeenCalledTimes(3);
    await runner.tick(); // done: no more calls
    expect(service.processHour).toHaveBeenCalledTimes(3);
  });

  it("a hung market call times out instead of blocking forever", async () => {
    const service = { processHour: vi.fn(), checkPrice: vi.fn() };
    const runner = new SignalRunner({
      service: service as never,
      market: { getFreshCandles: () => new Promise<Candle[]>(() => undefined) },
      settings: new StaticSignalSettings({ enabledSymbols: ["BTCUSDT"], triggerTimeframe: "1h" }),
      logger: silent,
      stateFile: join(dir, "s.json"),
      callTimeoutMs: 20,
    });
    await runner.tick();
    expect(runner.events()[0]?.detail).toMatch(/timed out/);
  });

  it("checks the live price against running signals", () => {
    const { service, make } = setup({ candles: () => [] });
    const runner = new SignalRunner({
      service: service as never,
      market: { getFreshCandles: async () => [] },
      prices: { getLatest: () => candle(T0, false) },
      settings: new StaticSignalSettings({ enabledSymbols: ["BTCUSDT"], triggerTimeframe: "1h" }),
      logger: silent,
      stateFile: join(dir, "p.json"),
    });
    runner.priceCheck();
    expect(service.checkPrice).toHaveBeenCalledWith("BTCUSDT", 1.5, expect.any(Number));
    void make;
  });
});

describe("signal runner: trigger timeframe", () => {
  it("asks for candles of the configured trigger timeframe and keeps its state per timeframe", async () => {
    const asked: string[] = [];
    const service = { processHour: vi.fn(async () => null as never), checkPrice: vi.fn() };
    const runner = new SignalRunner({
      service: service as never,
      market: {
        getFreshCandles: async (_s, interval) => {
          asked.push(interval);
          return [candle(T0 - 15 * 60_000, true), candle(T0, false)];
        },
      },
      settings: new StaticSignalSettings({ enabledSymbols: ["BTCUSDT"], triggerTimeframe: "15m" }),
      logger: silent,
      stateFile: join(dir, "runner-state.json"),
    });
    await runner.tick();
    expect(asked).toEqual(["15m"]);
    expect(JSON.parse(readFileSync(join(dir, "runner-state.json"), "utf8"))).toEqual({ "BTCUSDT:15m": T0 - 15 * 60_000 });
    expect(service.processHour).toHaveBeenCalledTimes(1);
  });
});

describe("watchdog", () => {
  it("restarts a stale runner and then leaves it alone for another full period", () => {
    let t = 1_000_000;
    const restart = vi.fn();
    const dog = new Watchdog({ logger: silent, now: () => t, parts: [{ name: "signal runner", lastActivity: () => 1_000_000, restart }] });
    t += 4 * 60_000;
    expect(dog.check()).toEqual([]);
    t += 61_000; // 5 minutes 1 second without activity
    expect(dog.check()).toEqual(["signal runner"]);
    expect(restart).toHaveBeenCalledTimes(1);
    t += 60_000;
    expect(dog.check()).toEqual([]);
  });

  it("really restarts a SignalRunner whose loop has gone quiet", async () => {
    let t = 5_000_000;
    const service = { processHour: vi.fn(), checkPrice: vi.fn() };
    const runner = new SignalRunner({
      service: service as never,
      market: { getFreshCandles: () => new Promise<Candle[]>(() => undefined) }, // stuck forever
      settings: new StaticSignalSettings({ enabledSymbols: ["BTCUSDT"], triggerTimeframe: "1h" }),
      logger: silent,
      stateFile: join(dir, "w.json"),
      now: () => t,
      callTimeoutMs: 10 * 60_000,
    });
    runner.start();
    expect(runner.runnerStatus()).toBe("running");
    t += 6 * 60_000;
    expect(runner.runnerStatus()).toBe("stale");
    const dog = new Watchdog({ logger: silent, now: () => t, parts: [{ name: "signal runner", lastActivity: () => runner.lastActivity(), restart: (r) => runner.restart(r) }] });
    expect(dog.check()).toEqual(["signal runner"]);
    expect(runner.events().at(-1)?.type).toBe("restart");
    runner.stop();
  });
});

describe("process guards", () => {
  it("logs an unhandled rejection and an uncaught exception and does not throw", () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const lines: unknown[] = [];
    const logger = { error: (o: unknown, m: string) => lines.push([o, m]) } as never;
    installProcessGuards(logger, { on: ((e: string, h: (a: unknown) => void) => void (handlers[e] = h)) as never });
    expect(() => handlers.unhandledRejection!(new Error("boom"))).not.toThrow();
    expect(() => handlers.uncaughtException!(new Error("bang"))).not.toThrow();
    expect(() => handlers.unhandledRejection!("plain string")).not.toThrow();
    expect(lines).toHaveLength(3);
    expect(JSON.stringify(lines)).toContain("boom");
  });

  it("the real process keeps running after an unhandled rejection", async () => {
    const calls: unknown[] = [];
    const logger = { error: (...a: unknown[]) => calls.push(a) } as never;
    const before = process.listeners("unhandledRejection");
    installProcessGuards(logger);
    // vitest installs its own handler; ours is the newly added one. Call it directly: the point is it returns.
    const ours = process.listeners("unhandledRejection").find((l) => !before.includes(l))!;
    expect(() => ours(new Error("late failure"), Promise.resolve())).not.toThrow();
    expect(calls).toHaveLength(1);
    process.removeListener("unhandledRejection", ours as never);
  });
});

describe("/health and /api/admin/runner", () => {
  const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghij123456";
  const CHANNEL = "@secret_channel_name";

  it("report the runner and Telegram state without any secret, and only admins see the runner log", async () => {
    const auth = new AuthService({ secret: "a-long-enough-test-secret", adminIds: () => ["admin"] });
    const admin = auth.issue({ id: "admin", email: "a@x.test", name: "A", emailVerified: true }).token;
    const user = auth.issue({ id: "u", email: "u@x.test", name: "U", emailVerified: true }).token;
    const events = [{ at: "2026-01-01T00:00:00.000Z", type: "evaluated", detail: "ok" }];
    const app = createApp({
      env: { CORS_ORIGINS: [] },
      logger: silent,
      clientCount: () => 0,
      auth,
      rateLimit: { limit: 1000 },
      healthExtra: () => ({ runnerStatus: "running", lastCandleTime: { BTCUSDT: "2026-01-01T00:00:00.000Z" }, lastSignalTime: null, telegramStatus: "active" }),
      adminServer: {
        version: "1",
        startedAt: Date.now(),
        secrets: {} as never,
        market: () => ({ status: "Live", provider: "bybit", lastPoll: {} }),
        telegram: () => ({ enabled: true, configured: true, lastSuccessAt: null, postsLast24h: 0, failedPosts: 0, abandonedPosts: 0 }),
        runnerReport: () => ({ events, telegram: [{ at: "x", signalId: "s1", kind: "signal", result: "failed", reason: "HTTP 400" }] }),
      },
    });
    const health = await request(app).get("/health").expect(200);
    expect(health.body).toMatchObject({ status: "ok", runnerStatus: "running", telegramStatus: "active", lastSignalTime: null });
    expect(health.body.lastCandleTime.BTCUSDT).toBeDefined();
    expect(typeof health.body.uptime).toBe("number");

    await request(app).get("/api/admin/runner").expect(401);
    await request(app).get("/api/admin/runner").set({ Authorization: `Bearer ${user}` }).expect(403);
    const res = await request(app).get("/api/admin/runner").set({ Authorization: `Bearer ${admin}` }).expect(200);
    expect(res.body.events).toHaveLength(1);
    for (const text of [JSON.stringify(health.body), JSON.stringify(res.body)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(CHANNEL);
    }
    expect(existsSync(dir)).toBe(true);
  });
});

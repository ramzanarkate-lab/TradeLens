import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { SettingsStore } from "../src/settings/store.js";
import { SignalServiceV2 } from "../src/signals/service.v2.js";
import { computeStats } from "../src/signals/stats.js";
import { SignalStore } from "../src/signals/store.js";
import type { Candle, Signal } from "../src/types/index.js";
import { EventEmitter } from "node:events";

const logger = createLogger({ level: "silent", pretty: false });
const SECRET = "unit-test-secret-at-least-16-chars";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

function build() {
  const settings = new SettingsStore(join(dir, "settings.json"), logger);
  settings.load();
  const auth = new AuthService({ secret: SECRET, adminIds: () => ["admin-1"] });
  const backtests = join(dir, "backtests");
  const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, auth, settings, backtestDir: backtests, rateLimit: { limit: 1000 } });
  return {
    app,
    settings,
    backtests,
    admin: auth.issue({ id: "admin-1", name: "A" }).token,
    user: auth.issue({ id: "u-1", name: "U" }).token,
  };
}

function writeBacktest(folder: string, symbol: string, verdict: "PASS" | "FAIL", date = "2026-11-01") {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${symbol}-${date}.json`), JSON.stringify({ verdict }));
}

describe("publishing gate (paper -> live)", () => {
  it("new signals start in paper mode", () => {
    expect(build().settings.get().signals.mode).toBe("paper");
  });

  it("non-admins cannot change the mode, but can still edit other strategy values", async () => {
    const { app, user, settings } = build();
    const res = await request(app).put("/api/settings/signals").set(bearer(user)).send({ mode: "live" }).expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    await request(app).put("/api/settings/signals").set(bearer(user)).send({ mode: "paper" }).expect(403);
    await request(app).put("/api/settings/signals").set(bearer(user)).send({ minScore: 75 }).expect(200);
    expect(settings.get().signals.minScore).toBe(75);
  });

  it("live mode is blocked without a PASS backtest for every enabled symbol", async () => {
    const { app, admin, settings, backtests } = build();
    const none = await request(app).put("/api/settings/signals").set(bearer(admin)).send({ mode: "live" }).expect(409);
    expect(none.body.error.code).toBe("BACKTEST_REQUIRED");
    expect(none.body.error.message).toContain("BTCUSDT");

    writeBacktest(backtests, "BTCUSDT", "PASS");
    writeBacktest(backtests, "SOLUSDT", "FAIL");
    writeBacktest(backtests, "ETHUSDT", "PASS");
    const failing = await request(app).put("/api/settings/signals").set(bearer(admin)).send({ mode: "live" }).expect(409);
    expect(failing.body.error.message).toContain("SOLUSDT");
    expect(failing.body.error.message).not.toContain("BTCUSDT");
    expect(settings.get().signals.mode).toBe("paper");
  });

  it("an admin can switch to live once every enabled symbol's latest backtest is PASS, and back to paper any time", async () => {
    const { app, admin, settings, backtests } = build();
    for (const s of ["BTCUSDT", "SOLUSDT", "ETHUSDT"]) writeBacktest(backtests, s, "PASS");
    await request(app).put("/api/settings/signals").set(bearer(admin)).send({ mode: "live" }).expect(200);
    expect(settings.get().signals.mode).toBe("live");
    await request(app).put("/api/settings/signals").set(bearer(admin)).send({ mode: "paper" }).expect(200);
  });

  it("uses the LATEST report: an older PASS does not count after a newer FAIL", async () => {
    const { app, admin, backtests } = build();
    writeBacktest(backtests, "BTCUSDT", "PASS", "2026-10-01");
    writeBacktest(backtests, "BTCUSDT", "FAIL", "2026-11-01");
    writeBacktest(backtests, "SOLUSDT", "PASS");
    writeBacktest(backtests, "ETHUSDT", "PASS");
    await request(app).put("/api/settings/signals").set(bearer(admin)).send({ mode: "live" }).expect(409);
  });

  it("validates the new ranges", async () => {
    const { app, admin } = build();
    for (const bad of [{ minScore: 101 }, { minScore: -1 }, { minRiskPercent: 0 }, { maxRiskPercent: 50 }, { timeStopHours: 0 }, { minRiskPercent: 5, maxRiskPercent: 4 }]) {
      await request(app).put("/api/settings/signals").set(bearer(admin)).send(bad).expect(400);
    }
    await request(app).put("/api/settings/signals").set(bearer(admin)).send({ minScore: 80, minRiskPercent: 0.5, maxRiskPercent: 3, timeStopHours: 24 }).expect(200);
  });
});

const base = (over: Partial<Signal>): Signal => ({
  id: "x", symbol: "BTCUSDT", side: "BUY", timeframe: "1h", price: 100, levels: { S1: 1, R2: 1, pivots: { P: 1, R1: 1, R2: 1, R3: 1, S1: 1, S2: 1, S3: 1 } },
  indicators: { emaFast: 1, emaSlow: 1, rsi: 50 }, trigger: "multi_indicator", reason: "", createdAt: 0, status: "OPEN", closedAt: null, resultR: null, ...over,
});
const closed = (id: string, status: Signal["status"], resultR: number, closedAt: number, tp1 = false): Signal =>
  base({ id, status, resultR, closedAt, statusHistory: tp1 ? [{ status: "TP1_HIT", at: 0, price: 1, resultR: 1 }] : [] });

describe("stats", () => {
  it("win rate, average R, profit factor and max drawdown on fixed results", () => {
    const stats = computeStats([
      closed("a", "TP3_HIT", 3, 1, true),
      closed("b", "SL_HIT", -1, 2),
      closed("c", "SL_HIT", -1, 3),
      closed("d", "TIME_EXIT", 2, 4, true),
      closed("e", "BREAKEVEN_EXIT", 0, 5, true), // reached TP1, then stopped at entry: still a win
      base({ id: "open" }),
    ]);
    expect(stats.total).toBe(6);
    expect(stats.open).toBe(1);
    expect(stats.closed).toBe(5);
    expect(stats.wins).toBe(3);
    expect(stats.winRate).toBe(60);
    expect(stats.avgR).toBe(0.6); // (3 - 1 - 1 + 2 + 0) / 5
    expect(stats.profitFactor).toBe(2.5); // 5 / 2
    expect(stats.maxDrawdownR).toBe(2); // 3 -> 2 -> 1 gives a fall of 2
    expect(stats.countByStatus).toMatchObject({ OPEN: 1, TP3_HIT: 1, SL_HIT: 2, TIME_EXIT: 1, BREAKEVEN_EXIT: 1 });
  });

  it("has no profit factor until there is a loss, and no rates before anything closes", () => {
    expect(computeStats([closed("a", "TP3_HIT", 3, 1, true)]).profitFactor).toBeNull();
    const empty = computeStats([]);
    expect(empty).toMatchObject({ total: 0, winRate: null, avgR: null, profitFactor: null, maxDrawdownR: 0 });
  });
});

describe("SignalStore history and filters", () => {
  it("keeps the whole history (no automatic deletion) and filters by symbol, side, status and dates", async () => {
    // Preload the file (one write) instead of adding 1200 signals one by one.
    const file = join(dir, "signals.json");
    const many = Array.from({ length: 1200 }, (_, k) => {
      const i = k + 1;
      return base({ id: `s${i}`, createdAt: i, symbol: i % 2 ? "BTCUSDT" : "ETHUSDT", side: i % 3 ? "BUY" : "SELL", status: i % 5 === 0 ? "SL_HIT" : "OPEN" });
    });
    writeFileSync(file, JSON.stringify(many));
    const store = new SignalStore(file, logger);
    store.load();
    expect(store.size).toBe(1200);
    expect(store.query({ symbol: "ETHUSDT", limit: 1000 }).total).toBe(600);
    expect(store.query({ side: "SELL" }).signals.every((s) => s.side === "SELL")).toBe(true);
    expect(store.query({ status: "SL_HIT" }).total).toBe(240);
    expect(store.query({ from: 100, to: 110 }).signals.map((s) => s.createdAt)).toEqual([110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100]);
    const page = store.query({ limit: 5, offset: 5 });
    expect(page.signals.map((s) => s.createdAt)).toEqual([1195, 1194, 1193, 1192, 1191]);
    expect(page.total).toBe(1200);
  });

  it("update() replaces a signal and persists it", async () => {
    const file = join(dir, "signals.json");
    const store = new SignalStore(file, logger);
    store.load();
    await store.add(base({ id: "a" }));
    await store.update(base({ id: "a", status: "TP1_HIT" }));
    const again = new SignalStore(file, logger);
    again.load();
    expect(again.get("a")?.status).toBe("TP1_HIT");
    expect(again.hasActive("BTCUSDT", "BUY")).toBe(true);
  });
});

describe("SignalServiceV2 keeps running signals up to date", () => {
  const HOUR = 3_600_000;
  const running = (): Signal =>
    base({
      id: "r1", entry: 100, sl: 97.7, tp1: 102.3, tp2: 104.6, tp3: 106.9, rrTp1: 1, rrTp2: 2, rrTp3: 3, createdAt: 10 * HOUR, mode: "paper",
      statusHistory: [{ status: "OPEN", at: 10 * HOUR, price: 100, resultR: null }],
    });
  const candle = (hourIndex: number, high: number, low: number, close: number): Candle => ({ time: hourIndex * HOUR, open: close, high, low, close, volume: 1, closed: true });

  async function setup() {
    const store = new SignalStore(join(dir, "signals.json"), logger);
    store.load();
    await store.add(running());
    const hub = { broadcast: vi.fn(() => 1) };
    const stream = new EventEmitter();
    const service = new SignalServiceV2({
      market: { getFreshCandles: async () => [] },
      stream: stream as never,
      store,
      settings: { get: () => ({ timeStopHours: 48 }) as never },
      hub,
      logger,
    });
    const updates: string[] = [];
    service.onUpdate((_s, c) => updates.push(`${c.status}:${c.resultR}`));
    return { store, hub, service, updates };
  }

  it("moves the stop to breakeven after TP1 and sends a signalUpdate event for each change", async () => {
    const { store, hub, service, updates } = await setup();
    // candles before the signal existed are ignored; the first candle after it hits TP1 only
    service.trackCandles("BTCUSDT", [candle(9, 200, 1, 100), candle(10, 103, 100.5, 102), candle(11, 101, 99.9, 100)], 48);
    expect(updates).toEqual(["TP1_HIT:1", "BREAKEVEN_EXIT:0"]);
    expect(store.get("r1")).toMatchObject({ status: "BREAKEVEN_EXIT", resultR: 0 });
    const events = (hub.broadcast.mock.calls as unknown as Array<[string, { event: string }]>).map((c) => c[1].event);
    expect(events).toEqual(["signalUpdate", "signalUpdate"]);
  });

  it("looks at each candle only once", async () => {
    const { service, updates } = await setup();
    const series = [candle(10, 103, 100.5, 102)];
    service.trackCandles("BTCUSDT", series, 48);
    service.trackCandles("BTCUSDT", series, 48);
    expect(updates).toEqual(["TP1_HIT:1"]);
  });

  it("a live price that reaches the stop closes the signal", async () => {
    const { store, service, updates } = await setup();
    service.checkPrice("BTCUSDT", 97.5, 10 * HOUR + 5_000);
    expect(updates).toEqual(["SL_HIT:-1"]);
    expect(store.get("r1")?.closedAt).toBe(10 * HOUR + 5_000);
  });

  it("a time stop closes it after 48 hours", async () => {
    const { store, service } = await setup();
    service.checkPrice("BTCUSDT", 101, 10 * HOUR + 48 * HOUR);
    expect(store.get("r1")).toMatchObject({ status: "TIME_EXIT", resultR: 0.43 });
  });
});

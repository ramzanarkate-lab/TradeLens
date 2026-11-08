import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIGNAL_SETTINGS } from "../src/config/signalDefaults.js";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { SignalEngine } from "../src/signals/engine.js";
import { SignalService } from "../src/signals/service.js";
import { StaticSignalSettings } from "../src/signals/settingsProvider.js";
import { SignalStore } from "../src/signals/store.js";
import type { Candle, PivotLevels, Signal } from "../src/types/index.js";

const logger = createLogger({ level: "silent", pretty: false });
const HOUR = 3_600_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-signals-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const makeSignal = (i: number, symbol: Signal["symbol"] = "BTCUSDT"): Signal => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  symbol,
  side: "BUY",
  timeframe: "1h",
  price: 100 + i,
  levels: { S1: 90, R2: 120, pivots: { P: 100, R1: 110, R2: 120, R3: 130, S1: 90, S2: 80, S3: 70 } },
  indicators: { emaFast: 1, emaSlow: 2, rsi: 50 },
  trigger: "ema_cross_up",
  reason: "test",
  createdAt: i,
});

describe("SignalStore", () => {
  it("persists signals and reloads them", async () => {
    const file = join(dir, "data", "signals.json");
    const a = new SignalStore(file, logger);
    a.load();
    await a.add(makeSignal(1));
    await a.add(makeSignal(2));

    const b = new SignalStore(file, logger);
    b.load();
    expect(b.size).toBe(2);
    expect(b.list().map((s) => s.createdAt)).toEqual([2, 1]); // newest first
    expect(b.get(makeSignal(1).id)?.price).toBe(101);
  });

  it("keeps only the newest max signals, in memory and on disk", async () => {
    const file = join(dir, "signals.json");
    const store = new SignalStore(file, logger, 3);
    store.load();
    for (let i = 1; i <= 5; i++) await store.add(makeSignal(i));
    expect(store.list({ limit: 10 }).map((s) => s.createdAt)).toEqual([5, 4, 3]);
    expect((JSON.parse(readFileSync(file, "utf8")) as Signal[]).map((s) => s.createdAt)).toEqual([3, 4, 5]);
  });

  it("filters by symbol and limit", async () => {
    const store = new SignalStore(join(dir, "s.json"), logger);
    store.load();
    await store.add(makeSignal(1, "BTCUSDT"));
    await store.add(makeSignal(2, "ETHUSDT"));
    await store.add(makeSignal(3, "BTCUSDT"));
    expect(store.list({ symbol: "BTCUSDT" }).map((s) => s.createdAt)).toEqual([3, 1]);
    expect(store.list({ limit: 1 }).map((s) => s.createdAt)).toEqual([3]);
  });

  it("sets a corrupt file aside instead of overwriting it", () => {
    const file = join(dir, "signals.json");
    writeFileSync(file, "{not json");
    const store = new SignalStore(file, logger);
    store.load();
    expect(store.size).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("signals.json.corrupt-"))).toBe(true);
  });
});

describe("GET /api/signals", () => {
  async function setup() {
    const store = new SignalStore(join(dir, "signals.json"), logger);
    store.load();
    for (let i = 1; i <= 4; i++) await store.add(makeSignal(i, i % 2 ? "BTCUSDT" : "SOLUSDT"));
    const auth = new AuthService({ secret: "unit-test-secret-at-least-16-chars", adminIds: () => [] });
    const token = auth.issue({ id: "u1", email: "u@x.test", name: "U" }).token;
    const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, signals: store, auth });
    return { app, store, bearer: { Authorization: `Bearer ${token}` } };
  }

  it("lists newest first, filters by symbol and limits", async () => {
    const { app, bearer } = await setup();
    await request(app).get("/api/signals").expect(401); // live signals need a Google sign-in
    const all = await request(app).get("/api/signals").set(bearer).expect(200);
    expect(all.body.signals.map((s: Signal) => s.createdAt)).toEqual([4, 3, 2, 1]);

    const btc = await request(app).get("/api/signals?symbol=BTCUSDT&limit=1").set(bearer).expect(200);
    expect(btc.body.signals.map((s: Signal) => s.createdAt)).toEqual([3]);
  });

  it("validates symbol and limit", async () => {
    const { app, bearer } = await setup();
    await request(app).get("/api/signals?symbol=DOGEUSDT").set(bearer).expect(400);
    await request(app).get("/api/signals?limit=0").set(bearer).expect(400);
    await request(app).get("/api/signals?limit=1001").set(bearer).expect(400);
  });

  it("an individual signal needs a sign-in", async () => {
    const { app } = await setup();
    // Individual signals need a sign-in; the list needs one too.
    await request(app).get(`/api/signals/${makeSignal(2, "SOLUSDT").id}`).expect(401);
  });
});

describe("SignalService (live runner)", () => {
  // Same fixed series as the engine tests: EMA3/EMA5 cross up at index 12 -> BUY.
  const CLOSES = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 12, 14, 16];
  const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HOUR); // aligned to the hour
  const series: Candle[] = CLOSES.map((close, i) => ({ time: T0 + i * HOUR, open: close, high: close + 1, low: close - 1, close, volume: 1, closed: true }));
  const pivots: PivotLevels = { P: 15, R1: 1e8, R2: 1e9, R3: 1e10, S1: 0, S2: -1, S3: -2 };

  function setup() {
    const settings = new StaticSignalSettings({ ...DEFAULT_SIGNAL_SETTINGS, emaFast: 3, emaSlow: 5, rsiPeriod: 5, rsiBuyMin: 30, rsiBuyMax: 80, rsiSellAbove: 99 });
    const stream = new EventEmitter();
    const hub = { broadcast: vi.fn(() => 1) };
    const store = new SignalStore(join(dir, "signals.json"), logger);
    store.load();
    const market = { getFreshCandles: vi.fn(async () => series), getPivots: vi.fn(async () => ({ symbol: "BTCUSDT", basis: "daily" as const, date: "x", ...pivots })) };
    const service = new SignalService({ market, stream, engine: new SignalEngine(settings), store, settings, hub, logger });
    service.start();
    return { stream, hub, store, market };
  }

  const oneMinute = (time: number, closed = true): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1, closed });

  it("runs on the last closed 1m candle of an hour, stores the signal and publishes it to topic signals", async () => {
    const { stream, hub, store, market } = setup();
    stream.emit("candle", "BTCUSDT", oneMinute(T0 + 59 * 60_000)); // last minute of the hour
    await vi.waitFor(() => expect(hub.broadcast).toHaveBeenCalled());

    expect(market.getFreshCandles).toHaveBeenCalledWith("BTCUSDT", "1h", 200);
    expect(store.size).toBe(1);
    const [topic, payload] = hub.broadcast.mock.calls[0] as unknown as [string, { event: string; signal: Signal }];
    expect(topic).toBe("signals");
    expect(payload.event).toBe("signal");
    expect(payload.signal).toMatchObject({ symbol: "BTCUSDT", side: "BUY", price: 16 });
    expect(store.get(payload.signal.id)).toEqual(payload.signal);
  });

  it("does nothing for mid-hour candles or candles that are still forming", async () => {
    const { stream, hub, market } = setup();
    stream.emit("candle", "BTCUSDT", oneMinute(T0 + 10 * 60_000)); // not the end of a bucket
    stream.emit("candle", "BTCUSDT", oneMinute(T0 + 59 * 60_000, false)); // end of bucket but not closed
    await new Promise((r) => setTimeout(r, 50));
    expect(market.getFreshCandles).not.toHaveBeenCalled();
    expect(hub.broadcast).not.toHaveBeenCalled();
  });
});

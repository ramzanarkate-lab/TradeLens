import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { makeTestSignal } from "../src/http/alertsRoutes.js";
import { createLogger } from "../src/logging/logger.js";
import { SignalStore } from "../src/signals/store.js";

const logger = createLogger({ level: "silent", pretty: false });
const auth = new AuthService({ secret: "unit-test-secret-at-least-16-chars", adminIds: () => ["admin-1"] });
const userToken = auth.issue({ id: "u1", email: "u@x.test", name: "U" }).token;
const adminToken = auth.issue({ id: "admin-1", email: "a@x.test", name: "A" }).token;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let dir: string;
let store: SignalStore;
let hub: { broadcast: ReturnType<typeof vi.fn> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-alerts-"));
  store = new SignalStore(join(dir, "signals.json"), logger);
  store.load();
  hub = { broadcast: vi.fn(() => 2) };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const app = () => createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, auth, signals: store, hub });

describe("POST /api/alerts/test", () => {
  it("is admin only: 401 for guests, 403 for users, and nothing is sent", async () => {
    await request(app()).post("/api/alerts/test").send({}).expect(401);
    const res = await request(app()).post("/api/alerts/test").set(bearer(userToken)).send({}).expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(hub.broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts a signal flagged test:true to topic signals", async () => {
    const res = await request(app()).post("/api/alerts/test").set(bearer(adminToken)).send({}).expect(200);

    expect(hub.broadcast).toHaveBeenCalledTimes(1);
    const [topic, payload] = hub.broadcast.mock.calls[0] as unknown as [string, { event: string; signal: Record<string, unknown> }];
    expect(topic).toBe("signals");
    expect(payload.event).toBe("signal");
    expect(payload.signal).toMatchObject({ symbol: "BTCUSDT", side: "BUY", timeframe: "1h", price: 67420, test: true });
    expect(String(payload.signal.reason)).toContain("Test alert");
    expect(res.body.signal).toEqual(payload.signal);
    expect(res.body.delivered).toBe(2);
  });

  it("does not store the signal: not in the store, not on disk, not in GET /api/signals", async () => {
    await request(app()).post("/api/alerts/test").set(bearer(adminToken)).send({ symbol: "ETHUSDT", side: "SELL" }).expect(200);
    await store.flush();

    expect(store.size).toBe(0);
    expect(existsSync(join(dir, "signals.json"))).toBe(false); // nothing was ever written
    const list = await request(app()).get("/api/signals").expect(200);
    expect(list.body.signals).toEqual([]);
  });

  it("accepts a symbol, side and price, and rejects anything else", async () => {
    const res = await request(app()).post("/api/alerts/test").set(bearer(adminToken)).send({ symbol: "SOLUSDT", side: "SELL", price: 151.5 }).expect(200);
    expect(res.body.signal).toMatchObject({ symbol: "SOLUSDT", side: "SELL", price: 151.5, test: true });

    for (const bad of [{ symbol: "DOGEUSDT" }, { side: "HOLD" }, { price: -1 }, { price: "high" }, { extra: 1 }]) {
      await request(app()).post("/api/alerts/test").set(bearer(adminToken)).send(bad).expect(400);
    }
    expect(hub.broadcast).toHaveBeenCalledTimes(1); // only the valid one
  });
});

describe("makeTestSignal", () => {
  it("builds a complete signal with levels, indicators and a fresh id each time", () => {
    const a = makeTestSignal({ symbol: "BTCUSDT", side: "BUY" }, 1234);
    const b = makeTestSignal({ symbol: "BTCUSDT", side: "BUY" }, 1234);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ createdAt: 1234, test: true, trigger: "ema_cross_up" });
    expect(a.levels.pivots.P).toBeGreaterThan(0);
    expect(makeTestSignal({ symbol: "ETHUSDT", side: "SELL" }, 1).trigger).toBe("ema_cross_down");
  });
});

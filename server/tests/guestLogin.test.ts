import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService, GUEST_SESSION_SECONDS } from "../src/auth/auth.js";
import { DemoTrader } from "../src/demotrade/demoTrader.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { SettingsStore } from "../src/settings/store.js";
import { SignalStore } from "../src/signals/store.js";

const silent = createLogger({ level: "silent", pretty: false });
const SECRET = "unit-test-secret-at-least-16-chars";
const DEVICE_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const DEVICE_B = "ffeeddccbbaa99887766554433221100";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-guest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function build() {
  // an operator who lists a guest-looking id and a verified email as admins: a guest must still not become one
  const auth = new AuthService({ secret: SECRET, adminIds: () => ["admin-1"], adminEmails: () => ["boss@x.test"] });
  const demo = new DemoTrader({ file: join(dir, "demo.json"), logger: silent });
  const signals = new SignalStore(join(dir, "signals.json"), silent);
  signals.load();
  const settings = new SettingsStore(join(dir, "settings.json"), silent);
  settings.load();
  const app = createApp({ env: { CORS_ORIGINS: [] }, logger: silent, clientCount: () => 0, auth, demo, signals, settings, rateLimit: { limit: 1000 } });
  return { app, auth };
}
const login = async (app: ReturnType<typeof build>["app"], deviceId: string) => (await request(app).post("/api/auth/guest").send({ deviceId }).expect(200)).body as { token: string; user: { id: string; name: string; role: string } };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("POST /api/auth/guest", () => {
  it("gives a guest a session of their own, as an ordinary user", async () => {
    const { app } = build();
    const { token, user } = await login(app, DEVICE_A);
    expect(user).toMatchObject({ id: `guest:${DEVICE_A}`, name: "Guest", role: "user" });
    const me = await request(app).get("/api/me").set(bearer(token)).expect(200);
    expect(me.body.role).toBe("user");
  });

  it("the session lasts a year, so a guest is not signed out after a week", async () => {
    const { app } = build();
    const { token } = await login(app, DEVICE_A);
    const claims = jwt.decode(token) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(GUEST_SESSION_SECONDS);
  });

  it("the same phone gets the same guest account every time", async () => {
    const { app } = build();
    expect((await login(app, DEVICE_A)).user.id).toBe((await login(app, DEVICE_A)).user.id);
    expect((await login(app, DEVICE_A)).user.id).not.toBe((await login(app, DEVICE_B)).user.id);
  });

  it("a guest can use what a Google user can: live signals, signal stats and a Demo account", async () => {
    const { app } = build();
    const { token } = await login(app, DEVICE_A);
    await request(app).get("/api/signals").set(bearer(token)).expect(200);
    await request(app).get("/api/signals/stats").set(bearer(token)).expect(200);
    const demo = await request(app).get("/api/demo").set(bearer(token)).expect(200);
    expect(demo.body.summary.balance).toBe(10_000);
    await request(app).get("/api/signals").expect(401); // without any session it is still closed
  });

  it("each guest has their own Demo account: a refill by one does not touch another", async () => {
    const { app } = build();
    const a = await login(app, DEVICE_A);
    const b = await login(app, DEVICE_B);
    await request(app).post("/api/demo/refill").set(bearer(a.token)).expect(200);
    await request(app).post("/api/demo/refill").set(bearer(a.token)).expect(429); // a has used today's refill
    await request(app).post("/api/demo/refill").set(bearer(b.token)).expect(200); // b has not
  });

  it("a guest is never an admin", async () => {
    const { app } = build();
    const { token } = await login(app, DEVICE_A);
    await request(app).get("/api/demo/settings").set(bearer(token)).expect(403);
    await request(app).put("/api/demo/settings").set(bearer(token)).send({ tradeSizeUsd: 5 }).expect(403);
  });

  it("rejects a missing, short or odd device id, and any extra field", async () => {
    const { app } = build();
    for (const body of [{}, { deviceId: "short" }, { deviceId: "has spaces in it 1234567" }, { deviceId: "x".repeat(65) }, { deviceId: DEVICE_A, role: "admin" }]) {
      await request(app).post("/api/auth/guest").send(body).expect(400);
    }
  });
});

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, createGoogleVerifier, SESSION_SECONDS, type IdTokenVerifierClient } from "../src/auth/auth.js";
import { UserStore } from "../src/auth/userStore.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { SecretsService } from "../src/settings/secrets.js";
import { SettingsStore } from "../src/settings/store.js";
import { SignalStore } from "../src/signals/store.js";
import type { Signal } from "../src/types/index.js";

const logger = createLogger({ level: "silent", pretty: false });
const SECRET = "unit-test-secret-at-least-16-chars";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let dir: string;
let admins: string[];
let users: UserStore;
let signals: SignalStore;
let settings: SettingsStore;
let auth: AuthService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-accounts-"));
  admins = ["admin-1"];
  users = new UserStore(join(dir, "users.json"), logger);
  users.load();
  signals = new SignalStore(join(dir, "signals.json"), logger);
  signals.load();
  settings = new SettingsStore(join(dir, "settings.json"), logger);
  settings.load();
  auth = new AuthService({ secret: SECRET, adminIds: () => admins, users });
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const app = () =>
  createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, auth, users, signals, settings, secrets: new SecretsService(join(dir, ".env"), {}) });

const login = (id: string, name = id) => auth.issue({ id, email: `${id}@x.test`, name }).token;

const signal = (n: number): Signal => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  symbol: "BTCUSDT", side: "BUY", timeframe: "1h", price: 100 + n, trigger: "ema_cross_up",
  levels: { S1: 1, R2: 2, pivots: { P: 1, R1: 1, R2: 2, R3: 3, S1: 1, S2: 0, S3: 0 } },
  indicators: { emaFast: 1, emaSlow: 2, rsi: 50 }, reason: `signal ${n}`, createdAt: n,
});

describe("UserStore", () => {
  it("creates a user on first sign-in and updates it on the next, ", async () => {
    let now = 1_000;
    const store = new UserStore(join(dir, "u2.json"), logger, () => now);
    store.load();
    const first = store.upsertOnLogin({ id: "google:1", email: "a@x.test", name: "A" });
    expect(first).toEqual({ id: "google:1", email: "a@x.test", name: "A", createdAt: 1_000, lastLoginAt: 1_000 });

    now = 5_000;
    const again = store.upsertOnLogin({ id: "google:1", email: "new@x.test", name: "A Renamed" });
    expect(again).toEqual({ id: "google:1", email: "new@x.test", name: "A Renamed", createdAt: 1_000, lastLoginAt: 5_000 });
    expect(store.size).toBe(1);
  });

  it("persists to users.json and reloads", async () => {
    users.upsertOnLogin({ id: "u1", email: "u1@x.test", name: "U1" });
    await users.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, "users.json"), "utf8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ id: "u1", email: "u1@x.test", name: "U1" });
    expect(onDisk[0]).not.toHaveProperty("role"); // roles are never stored

    const reloaded = new UserStore(join(dir, "users.json"), logger);
    reloaded.load();
    expect(reloaded.get("u1")?.email).toBe("u1@x.test");
  });

  it("sets a corrupt file aside", () => {
    writeFileSync(join(dir, "bad.json"), "{nope");
    const bad = new UserStore(join(dir, "bad.json"), logger);
    bad.load();
    expect(bad.size).toBe(0);
    expect(existsSync(join(dir, "bad.json"))).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("bad.json.corrupt-"))).toBe(true);
  });
});

describe("guests", () => {
  it("get 401 on protected routes", async () => {
    const a = app();
    await request(a).get("/api/me").expect(401);
    await request(a).put("/api/settings/signals").send({ emaFast: 9 }).expect(401);
    await request(a).put("/api/settings/chart").send({ showEma: false }).expect(401);
    await request(a).get("/api/settings/secrets/status").expect(401);
    await request(a).get("/api/signals").expect(401); // live signals need a Google sign-in
    await request(a).get("/api/signals/stats").expect(401);
  });

  it("can still read public data: guest settings (chart and alerts only)", async () => {
    const res = await request(app()).get("/api/settings").expect(200);
    expect(res.body.role).toBe("guest");
    expect(Object.keys(res.body.settings).sort()).toEqual(["alerts", "chart"]);
  });
});

describe("roles, computed on every request", () => {
  it("GET /api/me reports user and role", async () => {
    const res = await request(app()).get("/api/me").set(bearer(login("u1", "Una"))).expect(200);
    expect(res.body).toEqual({ user: { id: "u1", email: "u1@x.test", name: "Una" }, role: "user" });
  });

  it("a signed-in user can read and change their own settings", async () => {
    const t = login("u1");
    const read = await request(app()).get("/api/settings").set(bearer(t)).expect(200);
    expect(read.body.role).toBe("user");
    expect(read.body.settings.signals.emaFast).toBe(20);
    await request(app()).put("/api/settings/signals").set(bearer(t)).send({ emaFast: 9, emaSlow: 21 }).expect(200);
    expect(settings.section("signals")).toMatchObject({ emaFast: 9, emaSlow: 21 });
  });

  it("a user is not an admin: admin routes answer 403", async () => {
    const t = login("u1");
    await request(app()).get("/api/settings/secrets/status").set(bearer(t)).expect(403);
  });

  it("admins can use admin routes and report role admin", async () => {
    const t = login("admin-1");
    const me = await request(app()).get("/api/me").set(bearer(t)).expect(200);
    expect(me.body).toMatchObject({ role: "admin" });
  });

  it("a user removed from ADMIN_USER_IDS loses admin access on the very next request, with the same token", async () => {
    const t = login("admin-1");
    const a = app();
    await request(a).get("/api/me").set(bearer(t)).expect(200).then((r) => expect(r.body.role).toBe("admin"));

    admins = []; // the operator edits ADMIN_USER_IDS
    const after = await request(a).get("/api/me").set(bearer(t)).expect(200);
    expect(after.body.role).toBe("user");
    await request(a).get("/api/settings/secrets/status").set(bearer(t)).expect(403);
  });

  it("there is no Pro tier: the old endpoint is gone", async () => {
    await request(app()).put("/api/admin/users/u1/pro").set(bearer(login("admin-1"))).send({ pro: true }).expect(404);
  });
});

describe("what each role can read of the signal list", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 60; i++) await signals.add(signal(i));
  });

  it("guests get 401; every signed-in user pages through the full history for free", async () => {
    const a = app();
    await request(a).get("/api/signals").expect(401);
    const user = await request(a).get("/api/signals?limit=50").set(bearer(login("u1"))).expect(200);
    expect(user.body).toMatchObject({ role: "user", total: 60, hasMore: true, locked: false });
    expect(user.body.signals).toHaveLength(50);
    const page2 = await request(a).get("/api/signals?limit=50&offset=50").set(bearer(login("u1"))).expect(200);
    expect(page2.body.signals.map((s: Signal) => s.createdAt)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(page2.body.hasMore).toBe(false);
  });

  it("a smaller limit is respected", async () => {
    const res = await request(app()).get("/api/signals?limit=2").set(bearer(login("u1"))).expect(200);
    expect(res.body.signals).toHaveLength(2);
  });

  it("an individual signal needs a sign-in; guests get 401", async () => {
    const a = app();
    const id = signal(3).id;
    const guest = await request(a).get(`/api/signals/${id}`).expect(401);
    expect(guest.body.error.code).toBe("UNAUTHORIZED");
    await request(a).get(`/api/signals/${id}`).set(bearer(login("u1"))).expect(200);
  });

  it("stats need a sign-in, and every signed-in user gets the full numbers", async () => {
    const a = app();
    await request(a).get("/api/signals/stats").expect(401);
    const user = await request(a).get("/api/signals/stats").set(bearer(login("u1"))).expect(200);
    expect(user.body).toMatchObject({ tier: "full", total: 60 });
    for (const key of ["avgR", "profitFactor", "maxDrawdownR", "countByStatus"]) expect(user.body).toHaveProperty(key);
  });
});

describe("tokens", () => {
  it("rejects missing-header-as-guest, invalid, tampered, expired and unsigned tokens", async () => {
    const a = app();
    const good = login("u1");
    expect((await request(a).get("/api/me").expect(401)).body.error.code).toBe("UNAUTHORIZED");
    for (const bad of [
      "garbage",
      good + "x",
      jwt.sign({ sub: "u1" }, SECRET, { algorithm: "HS256", expiresIn: -60 }), // expired a minute ago
      jwt.sign({ sub: "u1" }, "another-secret-of-sufficient-length"), // wrong secret
      jwt.sign({ sub: "u1" }, "", { algorithm: "none" } as jwt.SignOptions), // unsigned
    ]) {
      const res = await request(a).get("/api/me").set(bearer(bad)).expect(401);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
    }
    await request(a).get("/api/me").set("Authorization", "Basic abc").expect(401);
  });

  it("sessions last 7 days", () => {
    expect(SESSION_SECONDS).toBe(7 * 24 * 3600);
    const { token } = auth.issue({ id: "u1", email: "u1@x.test", name: "U1" });
    const claims = jwt.decode(token) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(604_800);
  });
});

describe("Google sign-in", () => {
  const CLIENT_ID = "123456-configured.apps.googleusercontent.com";

  function fakeClient(payload: { sub?: string; email?: string; name?: string } | Error) {
    const verifyIdToken = vi.fn(async (_opts: { idToken: string; audience: string }) => {
      if (payload instanceof Error) throw payload;
      return { getPayload: () => payload };
    });
    return { client: { verifyIdToken } satisfies IdTokenVerifierClient, verifyIdToken };
  }

  it("verifies the token against the configured client ID (the audience)", async () => {
    const { client, verifyIdToken } = fakeClient({ sub: "42", email: "g@x.test", name: "Gee" });
    const verify = await createGoogleVerifier(CLIENT_ID, client);
    const profile = await verify("the-id-token");
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: "the-id-token", audience: CLIENT_ID });
    expect(profile).toMatchObject({ id: "google:42", email: "g@x.test", name: "Gee", emailVerified: false });
  });

  it("rejects a token the library refuses (wrong audience, expired, bad signature) and tokens without an email", async () => {
    const wrong = await createGoogleVerifier(CLIENT_ID, fakeClient(new Error("Wrong recipient, payload audience != requiredAudience")).client);
    await expect(wrong("t")).rejects.toThrow(/Wrong recipient/);
    const noEmail = await createGoogleVerifier(CLIENT_ID, fakeClient({ sub: "42" }).client);
    await expect(noEmail("t")).rejects.toThrow(/no subject or email/);
  });

  it("POST /api/auth/google creates the user, records the login and returns a 7-day session", async () => {
    const { client, verifyIdToken } = fakeClient({ sub: "42", email: "g@x.test", name: "Gee" });
    const googleAuth = new AuthService({ secret: SECRET, adminIds: () => ["google:42"], users, verifyGoogle: await createGoogleVerifier(CLIENT_ID, client) });
    const a = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, auth: googleAuth, users });

    const res = await request(a).post("/api/auth/google").send({ idToken: "x".repeat(40) }).expect(200);
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: "x".repeat(40), audience: CLIENT_ID });
    expect(res.body.user).toMatchObject({ id: "google:42", email: "g@x.test", name: "Gee", role: "admin" });
    const claims = jwt.decode(res.body.token) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(604_800);

    expect(users.get("google:42")).toMatchObject({ email: "g@x.test", name: "Gee" });
    expect(users.get("google:42")?.createdAt).toBeGreaterThan(0);
    const me = await request(a).get("/api/me").set(bearer(res.body.token)).expect(200);
    expect(me.body).toMatchObject({ role: "admin" });
  });

  it("a rejected Google token is a 401 and creates no user", async () => {
    const bad = new AuthService({ secret: SECRET, adminIds: () => [], users, verifyGoogle: await createGoogleVerifier(CLIENT_ID, fakeClient(new Error("Wrong recipient")).client) });
    const a = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, auth: bad, users });
    const res = await request(a).post("/api/auth/google").send({ idToken: "y".repeat(40) }).expect(401);
    expect(res.body.error.code).toBe("INVALID_GOOGLE_TOKEN");
    expect(users.size).toBe(0);
  });
});

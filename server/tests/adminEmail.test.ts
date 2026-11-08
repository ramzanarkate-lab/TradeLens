import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, createGoogleVerifier } from "../src/auth/auth.js";
import { UserStore } from "../src/auth/userStore.js";
import { liveEnvList } from "../src/auth/liveEnvList.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { ProviderRegistry } from "../src/market/providerRegistry.js";
import type { MarketProvider, ProviderName } from "../src/market/providers/types.js";
import { SecretsService } from "../src/settings/secrets.js";
import { SettingsStore } from "../src/settings/store.js";
import { TelegramClient } from "../src/telegram/telegramClient.js";

const ADMIN = "ramzanarkate@gmail.com";
const logger = createLogger({ level: "silent", pretty: false });
const SECRET = "unit-test-secret-at-least-16-chars";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-adminmail-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("admin by verified Google email", () => {
  let emails: string[];
  let auth: AuthService;
  beforeEach(() => {
    emails = [ADMIN];
    auth = new AuthService({ secret: SECRET, adminIds: () => [], adminEmails: () => emails });
  });
  const login = (email: string, emailVerified: boolean, id = "google:1") => auth.verify(auth.issue({ id, email, name: "N", emailVerified }).token)!;

  it("a verified ramzanarkate@gmail.com is Admin", () => {
    expect(login(ADMIN, true).role).toBe("admin");
  });

  it("the same address with email_verified false is only User", () => {
    expect(login(ADMIN, false).role).toBe("user");
  });

  it("a different Gmail address is User", () => {
    expect(login("someone.else@gmail.com", true, "google:2").role).toBe("user");
  });

  it("matching ignores case, on both sides", () => {
    expect(login("RAMZANARKATE@GMAIL.COM", true).role).toBe("admin");
    emails = ["RamzanArkate@Gmail.com"];
    expect(login(ADMIN, true).role).toBe("admin");
  });

  it("removing the email takes effect on the next request, for a session issued earlier", () => {
    const { token } = auth.issue({ id: "google:1", email: ADMIN, name: "N", emailVerified: true });
    expect(auth.verify(token)!.role).toBe("admin");
    emails = [];
    expect(auth.verify(token)!.role).toBe("user");
  });

  it("ADMIN_USER_IDS still works, and either one grants admin", () => {
    const both = new AuthService({ secret: SECRET, adminIds: () => ["google:9"], adminEmails: () => [ADMIN] });
    expect(both.verify(both.issue({ id: "google:9", email: "x@gmail.com", name: "X", emailVerified: false }).token)!.role).toBe("admin");
    expect(both.verify(both.issue({ id: "google:1", email: ADMIN, name: "A", emailVerified: true }).token)!.role).toBe("admin");
  });

  it("the role is never read from the token: a forged claim does nothing", () => {
    // A token signed with the right secret but carrying role/email_verified claims we do not use
    const forged = auth.issue({ id: "google:3", email: "mallory@gmail.com", name: "M", emailVerified: true }).token;
    expect(auth.verify(forged)!.role).toBe("user");
  });
});

describe("Google verification passes email_verified through", () => {
  const verifierFor = (payload: object) =>
    createGoogleVerifier("client-id", { verifyIdToken: async () => ({ getPayload: () => payload }) });

  it("verified email", async () => {
    const profile = await (await verifierFor({ sub: "1", email: ADMIN, name: "R", email_verified: true }))("t");
    expect(profile).toMatchObject({ id: "google:1", email: ADMIN, emailVerified: true });
  });
  it("missing or false means unverified", async () => {
    expect((await (await verifierFor({ sub: "1", email: ADMIN }))("t")).emailVerified).toBe(false);
    expect((await (await verifierFor({ sub: "1", email: ADMIN, email_verified: false }))("t")).emailVerified).toBe(false);
  });
});

describe("liveEnvList", () => {
  it("re-reads the file when it changes and lowercases the values", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "PORT=4000\nADMIN_EMAILS=A@x.com, b@x.com\n");
    const list = liveEnvList(file, "ADMIN_EMAILS", () => ["fallback"]);
    expect(list()).toEqual(["a@x.com", "b@x.com"]);
    writeFileSync(file, "ADMIN_EMAILS=\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(list()).toEqual([]);
  });
  it("falls back when there is no file or no such key", () => {
    expect(liveEnvList(join(dir, "nope"), "ADMIN_EMAILS", () => ["fallback"])()).toEqual(["fallback"]);
    const file = join(dir, ".env");
    writeFileSync(file, "PORT=4000\n");
    expect(liveEnvList(file, "ADMIN_EMAILS", () => ["fallback"])()).toEqual(["fallback"]);
  });
});

/** The whole server around the admin rule: who may call which endpoint. */
describe("admin-only endpoints", () => {
  function providerStub(name: ProviderName): MarketProvider {
    return {
      name,
      getCandles: vi.fn(async () => []),
      getTicker: vi.fn(async () => ({ price: 1, change24h: 0, changePercent24h: 0 })),
      ping: vi.fn(async () => ({ ok: true, detail: "OK", status: 200 })),
    };
  }

  async function build() {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "");
    const env: Record<string, string | undefined> = { NODE_ENV: "test", TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenForTestsOnly_abcdefghij123456", TELEGRAM_CHANNEL_ID: "@tradelens_test" };
    const secrets = new SecretsService(envFile, env);
    const registry = new ProviderRegistry({ mode: "auto", logger, providers: [providerStub("bybit"), providerStub("okx"), providerStub("kraken"), providerStub("binance")] });
    await registry.init();
    let emails = [ADMIN];
    const auth = new AuthService({ secret: SECRET, adminIds: () => [], adminEmails: () => emails });
    const settings = new SettingsStore(join(dir, "settings.json"), logger);
    settings.load();
    const client = new TelegramClient({ credentials: () => undefined, fetchFn: vi.fn() as unknown as typeof fetch, sleep: async () => {} });
    const app = createApp({
      env: { CORS_ORIGINS: [] },
      logger,
      clientCount: () => 0,
      auth,
      settings,
      secrets,
      rateLimit: { limit: 1000 },
      hub: { broadcast: () => 0 },
      users: (() => {
        const u = new UserStore(join(dir, "users.json"), logger);
        u.load();
        return u;
      })(),
      diagnostics: { report: () => registry.diagnostics() },
      telegram: { env: () => secrets.reloadedEnv, client, notifier: { status: () => ({ lastSuccessAt: null, postsLast24h: 0, failed: 0, abandoned: 0 }) } },
      adminServer: {
        version: "9.9.9",
        registry,
        startedAt: Date.now() - 5000,
        secrets,
        market: () => ({ status: "Live", provider: registry.activeName, lastPoll: { BTCUSDT: null } }),
        telegram: () => ({ enabled: false, configured: true, lastSuccessAt: null, postsLast24h: 0, failedPosts: 0, abandonedPosts: 0 }),
      },
    });
    const tokenFor = (email: string, verified: boolean, id: string) => auth.issue({ id, email, name: "N", emailVerified: verified }).token;
    return { app, registry, envFile, setEmails: (e: string[]) => (emails = e), admin: tokenFor(ADMIN, true, "google:1"), other: tokenFor("someone.else@gmail.com", true, "google:2"), unverified: tokenFor(ADMIN, false, "google:3") };
  }

  it("GET /api/me reports Admin for the verified admin email and User for everyone else", async () => {
    const { app, admin, other, unverified } = await build();
    // the older /api/me reply has role in lower case; the app maps it to Guest, User, Admin
    expect((await request(app).get("/api/me").set(bearer(admin)).expect(200)).body.role).toBe("admin");
    expect((await request(app).get("/api/me").set(bearer(other)).expect(200)).body.role).toBe("user");
    expect((await request(app).get("/api/me").set(bearer(unverified)).expect(200)).body.role).toBe("user");
    await request(app).get("/api/me").expect(401); // a guest has no session
  });

  it("another Gmail account, an unverified one and a guest get 403 or 401 on every admin endpoint", async () => {
    const { app, other, unverified } = await build();
    const calls: Array<[string, string, object?]> = [
      ["post", "/api/telegram/test"],
      ["put", "/api/settings/secrets", { TELEGRAM_ENABLED: "true" }],
      ["get", "/api/settings/secrets/status"],
      ["get", "/api/diagnostics"],
      ["get", "/api/admin/server"],
      ["put", "/api/admin/server/market-provider", { provider: "okx" }],
      ["post", "/api/alerts/test", {}],
    ];
    for (const [method, url, body] of calls) {
      for (const token of [other, unverified]) {
        const r = await (request(app) as never as Record<string, (u: string) => request.Test>)[method]!(url).set(bearer(token)).send(body ?? {});
        expect([url, r.status]).toEqual([url, 403]);
      }
      const guest = await (request(app) as never as Record<string, (u: string) => request.Test>)[method]!(url).send(body ?? {});
      expect([url, guest.status]).toEqual([url, 401]);
    }
  });

  it("the Telegram status gives non-admins only enabled, configured and channelLink", async () => {
    const { app, admin, other } = await build();
    const user = await request(app).get("/api/telegram/status").set(bearer(other)).expect(200);
    expect(Object.keys(user.body).sort()).toEqual(["channelLink", "configured", "enabled"]);
    const adm = await request(app).get("/api/telegram/status").set(bearer(admin)).expect(200);
    expect(adm.body).toHaveProperty("postsLast24h");
    expect(JSON.stringify(adm.body)).not.toContain("AAFakeToken");
  });

  it("an admin can read the server info, with no secret values", async () => {
    const { app, admin } = await build();
    const res = await request(app).get("/api/admin/server").set(bearer(admin)).expect(200);
    expect(res.body).toMatchObject({ version: "9.9.9", marketProvider: { active: "bybit", setting: "auto", live: true }, telegram: { configured: true } });
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(res.body)).not.toContain("AAFakeToken");
    expect(JSON.stringify(res.body)).not.toContain("tradelens_test");
  });

  it("an admin can switch the market provider without a restart; bad names are rejected", async () => {
    const { app, admin, registry, envFile } = await build();
    expect(registry.activeName).toBe("bybit");
    const res = await request(app).put("/api/admin/server/market-provider").set(bearer(admin)).send({ provider: "kraken" }).expect(200);
    expect(res.body).toEqual({ setting: "kraken", active: "kraken" });
    expect(registry.activeName).toBe("kraken");
    expect(registry.currentMode).toBe("kraken");
    expect((await import("node:fs")).readFileSync(envFile, "utf8")).toContain("MARKET_PROVIDER=kraken");
    await request(app).put("/api/admin/server/market-provider").set(bearer(admin)).send({ provider: "auto" }).expect(200);
    expect(registry.activeName).toBe("bybit");
    await request(app).put("/api/admin/server/market-provider").set(bearer(admin)).send({ provider: "ftx" }).expect(400);
  });

  it("removing the admin email takes effect on the very next request", async () => {
    const { app, admin, setEmails } = await build();
    await request(app).get("/api/diagnostics").set(bearer(admin)).expect(200);
    setEmails([]);
    await request(app).get("/api/diagnostics").set(bearer(admin)).expect(403);
  });
});

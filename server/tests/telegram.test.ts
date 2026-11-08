import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { SecretsService } from "../src/settings/secrets.js";
import { SettingsStore } from "../src/settings/store.js";
import { TelegramClient } from "../src/telegram/telegramClient.js";
import { TelegramNotifier } from "../src/telegram/telegramNotifier.js";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghij123456";
const CHANNEL = "@tradelens_test";
const logger = createLogger({ level: "silent", pretty: false });

const okResponse = (messageId = 7) => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
const fail = (status: number, extra: object = {}) =>
  new Response(JSON.stringify({ ok: false, description: "nope", ...extra }), { status });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-telegram-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function client(fetchFn: typeof fetch, sleep = vi.fn(async () => {})) {
  return { sleep, client: new TelegramClient({ credentials: () => ({ token: TOKEN, chatId: CHANNEL }), fetchFn, sleep }) };
}

function notifier(sendMessage: TelegramClient["sendMessage"]) {
  return new TelegramNotifier({
    client: { sendMessage },
    enabled: () => true,
    timeZone: () => "Asia/Riyadh",
    sentFile: join(dir, "telegram-sent.json"),
    failedFile: join(dir, "telegram-failed.json"),
    log: logger,
  });
}

describe("TelegramClient", () => {
  it("sends HTML with link previews off and returns the message id", async () => {
    const fetchFn = vi.fn(async () => okResponse(42));
    const { client: c } = client(fetchFn as unknown as typeof fetch);
    expect(await c.sendMessage("hi")).toEqual({ ok: true, messageId: 42 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: CHANNEL, text: "hi", parse_mode: "HTML", disable_web_page_preview: true });
  });

  it("waits for retry_after on HTTP 429, then retries", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(fail(429, { parameters: { retry_after: 9 } })).mockResolvedValueOnce(okResponse());
    const { client: c, sleep } = client(fetchFn as unknown as typeof fetch);
    expect((await c.sendMessage("x")).ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(9_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("backs off 2s, 5s, 15s on 5xx and gives up after the third retry", async () => {
    const fetchFn = vi.fn(async () => fail(502));
    const { client: c, sleep } = client(fetchFn as unknown as typeof fetch);
    const result = await c.sendMessage("x");
    expect(result.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((x) => x[0])).toEqual([2_000, 5_000, 15_000]);
  });

  it("does not retry a rejected request (HTTP 400)", async () => {
    const fetchFn = vi.fn(async () => fail(400));
    const { client: c } = client(fetchFn as unknown as typeof fetch);
    expect((await c.sendMessage("x")).ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("removes the token from network error text", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const { client: c } = client(fetchFn as unknown as typeof fetch);
    const result = await c.sendMessage("x");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("AAFakeToken");
  });
});

describe("Telegram endpoints", () => {
  let envFile: string;
  let env: Record<string, string | undefined>;
  const SECRET = "unit-test-secret-at-least-16-chars";

  function build(fetchFn: typeof fetch) {
    envFile = join(dir, ".env");
    writeFileSync(envFile, "");
    env = { NODE_ENV: "test" };
    const secrets = new SecretsService(envFile, env);
    const auth = new AuthService({ secret: SECRET, adminIds: () => ["admin-1"] });
    const tc = new TelegramClient({
      credentials: () => {
        const e = secrets.reloadedEnv;
        return e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHANNEL_ID ? { token: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHANNEL_ID } : undefined;
      },
      fetchFn,
      sleep: async () => {},
    });
    const tp = notifier(tc.sendMessage.bind(tc));
    const settings = new SettingsStore(join(dir, "settings.json"), logger);
    settings.load();
    const app = createApp({
      env: { CORS_ORIGINS: [] },
      logger,
      clientCount: () => 0,
      auth,
      settings,
      secrets,
      rateLimit: { limit: 1000 },
      telegram: { env: () => secrets.reloadedEnv, client: tc, notifier: tp },
    });
    return { app, adminToken: auth.issue({ id: "admin-1", name: "A" }).token, userToken: auth.issue({ id: "u-1", name: "U" }).token };
  }

  it("lets non-admins read only enabled, configured and channelLink; admins also get the numbers", async () => {
    const { app, adminToken, userToken } = build(vi.fn(async () => okResponse()) as unknown as typeof fetch);
    const user = await request(app).get("/api/telegram/status").set("Authorization", `Bearer ${userToken}`).expect(200);
    expect(Object.keys(user.body).sort()).toEqual(["channelLink", "configured", "enabled"]);
    const admin = await request(app).get("/api/telegram/status").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(admin.body).toMatchObject({ enabled: true, configured: false, lastSuccessAt: null, postsLast24h: 0, failedPosts: 0 });
  });

  it("the channel link is a free benefit of signing in: a guest gets an empty link, any signed-in user gets it", async () => {
    const { app, adminToken, userToken } = build(vi.fn(async () => okResponse()) as unknown as typeof fetch);
    await request(app).put("/api/settings/secrets").set("Authorization", `Bearer ${adminToken}`).send({ TELEGRAM_CHANNEL_LINK: "https://t.me/tradelens_test" }).expect(200);
    expect((await request(app).get("/api/telegram/status").expect(200)).body.channelLink).toBe("");
    expect((await request(app).get("/api/telegram/status").set("Authorization", `Bearer ${userToken}`).expect(200)).body.channelLink).toBe("https://t.me/tradelens_test");
  });

  it("test endpoint is admin only and never returns the token", async () => {
    const { app, adminToken, userToken } = build(vi.fn(async () => fail(401)) as unknown as typeof fetch);
    await request(app).post("/api/telegram/test").expect(401);
    await request(app).post("/api/telegram/test").set("Authorization", `Bearer ${userToken}`).expect(403);
    await request(app).put("/api/settings/secrets").set("Authorization", `Bearer ${adminToken}`).send({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHANNEL_ID: CHANNEL }).expect(200);
    const res = await request(app).post("/api/telegram/test").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("AAFakeToken");
  });

  it("applies a new token, channel, enabled flag and link without a restart", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const { app, adminToken } = build(fetchFn as unknown as typeof fetch);
    const auth = { Authorization: `Bearer ${adminToken}` };
    const before = await request(app).post("/api/telegram/test").set(auth).expect(200);
    expect(before.body).toEqual({ ok: false, reason: "Telegram is not configured" });

    const put = await request(app)
      .put("/api/settings/secrets")
      .set(auth)
      .send({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHANNEL_ID: CHANNEL, TELEGRAM_ENABLED: "true", TELEGRAM_CHANNEL_LINK: "https://t.me/tradelens_test" })
      .expect(200);
    expect(JSON.stringify(put.body)).not.toContain("AAFakeToken");

    expect((await request(app).post("/api/telegram/test").set(auth).expect(200)).body).toEqual({ ok: true });
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toContain(TOKEN);
    const status = await request(app).get("/api/telegram/status").set(auth).expect(200);
    expect(status.body).toMatchObject({ enabled: true, configured: true, channelLink: "https://t.me/tradelens_test" });
    expect(JSON.stringify(status.body)).not.toContain("AAFakeToken");
    expect(readFileSync(envFile, "utf8")).toContain("TELEGRAM_ENABLED=true");
  });

  it("rejects a bad enabled flag or link", async () => {
    const { app, adminToken } = build(vi.fn() as unknown as typeof fetch);
    const auth = { Authorization: `Bearer ${adminToken}` };
    await request(app).put("/api/settings/secrets").set(auth).send({ TELEGRAM_ENABLED: "yes" }).expect(400);
    await request(app).put("/api/settings/secrets").set(auth).send({ TELEGRAM_CHANNEL_LINK: "javascript:alert(1)" }).expect(400);
  });
});

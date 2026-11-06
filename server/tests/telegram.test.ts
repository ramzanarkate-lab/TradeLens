import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { SecretsService } from "../src/settings/secrets.js";
import { SettingsStore } from "../src/settings/store.js";
import { formatSignal, formatStatusUpdate, formatTime } from "../src/telegram/formatSignal.js";
import { TelegramClient } from "../src/telegram/telegramClient.js";
import { MAX_RETRIES, TelegramPoster } from "../src/telegram/telegramPoster.js";
import type { Signal, StatusChange } from "../src/types/index.js";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghij123456";
const CHANNEL = "@tradelens_test";
const START = Date.UTC(2026, 10, 6, 13, 0, 0); // 16:00 in Riyadh
const logger = createLogger({ level: "silent", pretty: false });

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: "sig-1",
    symbol: "BTCUSDT",
    side: "BUY",
    timeframe: "1h",
    price: 67420,
    levels: { S1: 66900, R2: 68100, pivots: { P: 67000, R1: 67500, R2: 68100, R3: 68600, S1: 66900, S2: 66300, S3: 65800 } },
    indicators: { emaFast: 67350, emaSlow: 67100, rsi: 52.4 },
    trigger: "ema_cross_up",
    reason: "EMA 20 crossed above EMA 50",
    createdAt: Date.UTC(2026, 10, 6, 13, 20, 0), // 16:20 in Riyadh
    mode: "live",
    ...over,
  };
}

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

function poster(sendMessage: TelegramClient["sendMessage"], over: Partial<ConstructorParameters<typeof TelegramPoster>[0]> = {}) {
  return new TelegramPoster({
    client: { sendMessage },
    enabled: () => true,
    timeZone: () => "Asia/Riyadh",
    sentFile: join(dir, "telegram-sent.json"),
    failedFile: join(dir, "telegram-failed.json"),
    log: logger,
    startedAt: START,
    ...over,
  });
}

describe("message format", () => {
  it("formats a BUY message in the expected HTML", () => {
    expect(formatSignal(signal(), { timeZone: "Asia/Riyadh" })).toBe(
      [
        "<b>🟢 BUY BTCUSDT</b> (1h)",
        "Price: 67,420.00",
        "Support S1: 66,900.00 | Resistance R2: 68,100.00",
        "EMA20 / EMA50: 67,350.00 / 67,100.00",
        "RSI(14): 52.4",
        "Reason: EMA 20 crossed above EMA 50",
        "Time: 2026-11-06 16:20 (UTC+3)",
        "",
        "Not financial advice. Trade at your own risk.",
      ].join("\n"),
    );
  });

  it("uses the red icon for SELL and the symbol's tick size", () => {
    const text = formatSignal(signal({ side: "SELL", symbol: "SOLUSDT", price: 150.1234 }), { timeZone: "Asia/Riyadh" });
    expect(text).toContain("<b>🔴 SELL SOLUSDT</b> (1h)");
    expect(text).toContain("Price: 150.123");
  });

  it("escapes <, > and & in the reason", () => {
    const text = formatSignal(signal({ reason: "RSI < 30 & price > <b>EMA</b>" }), { timeZone: "UTC" });
    expect(text).toContain("Reason: RSI &lt; 30 &amp; price &gt; &lt;b&gt;EMA&lt;/b&gt;");
    expect(text).not.toContain("<b>EMA</b>");
  });

  it("converts the time zone, including half-hour offsets and UTC", () => {
    expect(formatTime(START, "Asia/Kolkata")).toBe("2026-11-06 18:30 (UTC+5:30)");
    expect(formatTime(START, "UTC")).toMatch(/\(UTC\)$/);
  });
});

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

describe("TelegramPoster", () => {
  it("posts a signal only once, even if the engine emits it twice (also at the same time)", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const p = poster(send);
    await Promise.all([p.handle(signal()), p.handle(signal())]);
    await p.handle(signal());
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dir, "telegram-sent.json"), "utf8"))).toHaveLength(1);
  });

  it("does not repost after a restart", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    await poster(send).handle(signal());
    await poster(send).handle(signal()); // new instance reads telegram-sent.json
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("skips signals created before the server started and test signals", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const p = poster(send);
    await p.handle(signal({ id: "old", createdAt: START - 1 }));
    await p.handle(signal({ id: "test", test: true }));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing and throws nothing when Telegram is disabled", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const p = poster(send, { enabled: () => false });
    await expect(p.handle(signal())).resolves.toBeUndefined();
    await expect(p.retryFailed()).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("stores a failed post, retries it later, and clears it on success", async () => {
    const send = vi
      .fn<TelegramClient["sendMessage"]>()
      .mockResolvedValueOnce({ ok: false, reason: "Telegram HTTP 502" })
      .mockResolvedValueOnce({ ok: true, messageId: 5 });
    const p = poster(send);
    await p.handle(signal());
    expect(p.status().failed).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "telegram-failed.json"), "utf8"))[0].signal.id).toBe("sig-1");

    await p.retryFailed();
    expect(send).toHaveBeenCalledTimes(2);
    expect(p.status()).toMatchObject({ failed: 0, postsLast24h: 1 });
    expect(JSON.parse(readFileSync(join(dir, "telegram-failed.json"), "utf8"))).toEqual([]);
  });

  it("abandons a post after 12 failed retries and stops trying", async () => {
    const send = vi.fn<TelegramClient["sendMessage"]>(async () => ({ ok: false, reason: "down" }));
    const p = poster(send);
    await p.handle(signal());
    for (let i = 0; i < MAX_RETRIES + 3; i++) await p.retryFailed();
    expect(send).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(p.status()).toMatchObject({ failed: 1, abandoned: 1 });
  });

  it("keeps only the newest 1000 sent ids", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    writeFileSync(join(dir, "telegram-sent.json"), JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, at: 1 }))));
    const p = poster(send);
    await p.handle(signal({ id: "new" }));
    const saved = JSON.parse(readFileSync(join(dir, "telegram-sent.json"), "utf8")) as Array<{ id: string }>;
    expect(saved).toHaveLength(1000);
    expect(saved[0]!.id).toBe("old-1");
    expect(saved[999]!.id).toBe("new");
  });

  it("never writes the token to the log, even when the network error contains it", async () => {
    let logged = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        logged += String(chunk);
        cb();
      },
    });
    const fetchFn = vi.fn(async () => {
      throw new Error(`failed: https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const { client: c } = client(fetchFn as unknown as typeof fetch);
    const p = new TelegramPoster({
      client: c,
      enabled: () => true,
      timeZone: () => "UTC",
      sentFile: join(dir, "s.json"),
      failedFile: join(dir, "f.json"),
      log: pino({ level: "info" }, sink),
      startedAt: START,
    });
    await p.handle(signal());
    expect(logged).toContain("telegram post");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("AAFakeToken");
  });
});

describe("multi-indicator signals on Telegram", () => {
  const full = (over: Partial<Signal> = {}): Signal =>
    signal({
      entry: 67420, sl: 66900, tp1: 67940, tp2: 68460, tp3: 68980, riskPercent: 0.77, rrTp1: 1, rrTp2: 2, rrTp3: 3, score: 82,
      reasons: ["1D close above EMA200 (trend filter)", "4H EMA20 above EMA50", "1H MACD histogram crossed above 0", "Volume 1.40x its 20-candle average"],
      status: "OPEN", ...over,
    });

  it("shows entry, SL, TP1-TP3, risk, score, and at most 3 reasons, with the disclaimer", () => {
    const text = formatSignal(full(), { timeZone: "Asia/Riyadh" });
    expect(text).toBe(
      [
        "<b>🟢 BUY BTCUSDT</b> (1h) · Score 82/100",
        "Entry: 67,420.00",
        "SL: 66,900.00 (risk 0.77%)",
        "TP1: 67,940.00 (1.0R)",
        "TP2: 68,460.00 (2.0R)",
        "TP3: 68,980.00 (3.0R)",
        "Why:",
        "• 1D close above EMA200 (trend filter)",
        "• 4H EMA20 above EMA50",
        "• 1H MACD histogram crossed above 0",
        "Time: 2026-11-06 16:20 (UTC+3)",
        "",
        "Not financial advice. Trade at your own risk.",
      ].join("\n"),
    );
  });

  it("a status update keeps the format and adds the result in R", () => {
    const text = formatStatusUpdate(full(), { status: "TP1_HIT", at: START, price: 67940, resultR: 1 }, { timeZone: "Asia/Riyadh" });
    expect(text).toContain("Entry: 67,420.00");
    expect(text).toContain("Update: <b>TP1 HIT</b> at 67,940.00 (+1.0R)");
    expect(text).toContain("Not financial advice");
    const stop = formatStatusUpdate(full(), { status: "SL_HIT", at: START, price: 66900, resultR: -1 }, { timeZone: "UTC" });
    expect(stop).toContain("(-1.0R)");
  });

  it("paper signals are never posted; live ones are", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const p = poster(send);
    await p.handle(full({ id: "paper", mode: "paper" }));
    expect(send).not.toHaveBeenCalled();
    await p.handle(full({ id: "live", mode: "live" }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("posts TP1, TP2, TP3 and SL updates once each, and nothing for other statuses or paper signals", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const p = poster(send);
    const s = full();
    const change = (status: StatusChange["status"], resultR: number) => ({ status, at: START + 1, price: 1, resultR });
    await p.handleUpdate(s, change("TP1_HIT", 1));
    await p.handleUpdate(s, change("TP1_HIT", 1)); // twice
    await p.handleUpdate(s, change("SL_HIT", -1));
    await p.handleUpdate(s, change("BREAKEVEN_EXIT", 0));
    await p.handleUpdate(s, change("TIME_EXIT", 0.2));
    await p.handleUpdate(full({ mode: "paper" }), change("TP2_HIT", 2));
    expect(send).toHaveBeenCalledTimes(2);
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
    const tp = poster(tc.sendMessage.bind(tc));
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
      telegram: { env: () => secrets.reloadedEnv, client: tc, poster: tp },
    });
    return { app, adminToken: auth.issue({ id: "admin-1", name: "A" }).token, userToken: auth.issue({ id: "u-1", name: "U" }).token };
  }

  it("lets non-admins read only enabled, configured and channelLink; admins also get the numbers", async () => {
    const { app, adminToken, userToken } = build(vi.fn(async () => okResponse()) as unknown as typeof fetch);
    const user = await request(app).get("/api/telegram/status").set("Authorization", `Bearer ${userToken}`).expect(200);
    expect(Object.keys(user.body).sort()).toEqual(["channelLink", "configured", "enabled"]);
    const admin = await request(app).get("/api/telegram/status").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(admin.body).toMatchObject({ enabled: false, configured: false, lastSuccessAt: null, postsLast24h: 0, failedPosts: 0 });
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

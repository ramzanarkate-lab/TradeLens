import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { SecretsService } from "../src/settings/secrets.js";
import { SettingsStore, type SettingsChange } from "../src/settings/store.js";
import type { Logger } from "../src/logging/logger.js";

const SECRET = "unit-test-secret-at-least-16-chars";

// Distinctive values so any leak is easy to spot.
const API_KEY = "ZZtopSecretKeyAAAA1111BBBB2222";
const API_SECRET = "ZZtopSecretSecretCCCC3333DDDD4444";
const BOT_TOKEN = "987654321:ZZtopBotTokenEEEE5555FFFF6666GGGG7777";
const CHANNEL = "@zztopchannel";

let dir: string;
let logLines: string[];
let logger: Logger;
let store: SettingsStore;
let envFile: string;
let fakeEnv: Record<string, string | undefined>;
let events: SettingsChange[];
const auth = new AuthService({ secret: SECRET, adminIds: () => ["admin-1"] });
const userToken = auth.issue({ id: "u1", email: "u1@example.com", name: "U One" }).token;
const adminToken = auth.issue({ id: "admin-1", email: "a@example.com", name: "Admin" }).token;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-settings-api-"));
  logLines = [];
  logger = pino({ level: "trace" }, { write: (line: string) => void logLines.push(line) });
  store = new SettingsStore(join(dir, "settings.json"), logger);
  store.load();
  events = [];
  store.on("changed", (e: SettingsChange) => events.push(e));
  envFile = join(dir, ".env");
  writeFileSync(envFile, "PORT=4000\n# keep this comment\nBINANCE_API_KEY=oldvalueoldvalueold1\n");
  fakeEnv = { PORT: "4000", BINANCE_API_KEY: "oldvalueoldvalueold1" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const app = () =>
  createApp({
    env: { CORS_ORIGINS: [] },
    logger,
    clientCount: () => 0,
    auth,
    settings: store,
    secrets: new SecretsService(envFile, fakeEnv),
  });

describe("GET /api/settings", () => {
  it("guests get only the chart and alerts sections", async () => {
    const res = await request(app()).get("/api/settings").expect(200);
    expect(res.body.role).toBe("guest");
    expect(Object.keys(res.body.settings).sort()).toEqual(["alerts", "chart"]);
    expect(res.body.settings.chart.defaultSymbol).toBe("BTCUSDT");
  });

  it("signed-in users get everything and their role", async () => {
    const res = await request(app()).get("/api/settings").set(bearer(userToken)).expect(200);
    expect(res.body.role).toBe("user");
    expect(Object.keys(res.body.settings).sort()).toEqual(["alerts", "chart", "general", "signals", "symbols"]);
    expect(res.body.settings.signals.emaFast).toBe(20);
  });

  it("a bad token is a 401, not silently a guest", async () => {
    await request(app()).get("/api/settings").set(bearer("garbage")).expect(401);
  });
});

describe("PUT /api/settings/<section>", () => {
  it("requires sign-in", async () => {
    for (const section of ["signals", "symbols", "general", "chart", "alerts"]) {
      const res = await request(app()).put(`/api/settings/${section}`).send({}).expect(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("updates, persists, returns the new values and emits a change", async () => {
    const res = await request(app()).put("/api/settings/signals").set(bearer(userToken)).send({ emaFast: 9, emaSlow: 21 }).expect(200);
    expect(res.body).toMatchObject({ section: "signals", values: { emaFast: 9, emaSlow: 21, rsiPeriod: 14 } });
    expect(store.section("signals").emaFast).toBe(9);
    expect(events.map((e) => e.section)).toEqual(["signals"]);
    const read = await request(app()).get("/api/settings").set(bearer(userToken)).expect(200);
    expect(read.body.settings.signals).toMatchObject({ emaFast: 9, emaSlow: 21 });
  });

  it("rejects emaFast >= emaSlow with 400 and changes nothing", async () => {
    const res = await request(app()).put("/api/settings/signals").set(bearer(userToken)).send({ emaFast: 50, emaSlow: 50 }).expect(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(res.body.error.message).toContain("emaFast must be less than emaSlow");
    expect(store.section("signals").emaFast).toBe(20);
    expect(events).toHaveLength(0);
  });

  it("rejects unknown keys and out-of-range values", async () => {
    await request(app()).put("/api/settings/alerts").set(bearer(userToken)).send({ sound: true, nope: 1 }).expect(400);
    await request(app()).put("/api/settings/signals").set(bearer(userToken)).send({ rsiBuyMin: 0 }).expect(400);
    await request(app()).put("/api/settings/symbols").set(bearer(userToken)).send({ enabled: ["DOGEUSDT"] }).expect(400);
    await request(app()).put("/api/settings/general").set(bearer(userToken)).send({ language: "fr" }).expect(400);
  });

  it("covers general, chart and alerts", async () => {
    await request(app()).put("/api/settings/general").set(bearer(userToken)).send({ theme: "light" }).expect(200);
    await request(app()).put("/api/settings/chart").set(bearer(userToken)).send({ defaultSymbol: "SOLUSDT", showEma: false }).expect(200);
    await request(app()).put("/api/settings/alerts").set(bearer(userToken)).send({ sound: false }).expect(200);
    expect(store.get()).toMatchObject({
      general: { language: "en", theme: "light" },
      chart: { defaultSymbol: "SOLUSDT", showEma: false, showPivots: true },
      alerts: { sound: false, vibration: true },
    });
  });
});

describe("secrets endpoints", () => {
  it("block guests (401) and non-admin users (403)", async () => {
    const a = app();
    expect((await request(a).get("/api/settings/secrets/status").expect(401)).body.error.code).toBe("UNAUTHORIZED");
    expect((await request(a).get("/api/settings/secrets/status").set(bearer(userToken)).expect(403)).body.error.code).toBe("FORBIDDEN");
    await request(a).put("/api/settings/secrets").send({ BINANCE_API_KEY: API_KEY }).expect(401);
    await request(a).put("/api/settings/secrets").set(bearer(userToken)).send({ BINANCE_API_KEY: API_KEY }).expect(403);
    // nothing was written
    expect(readFileSync(envFile, "utf8")).not.toContain(API_KEY);
    expect(fakeEnv.BINANCE_API_KEY).toBe("oldvalueoldvalueold1");
  });

  it("status reports set / not set and never a value", async () => {
    const res = await request(app()).get("/api/settings/secrets/status").set(bearer(adminToken)).expect(200);
    expect(res.body).toEqual({
      secrets: { BINANCE_API_KEY: true, BINANCE_API_SECRET: false, TELEGRAM_BOT_TOKEN: false, TELEGRAM_CHANNEL_ID: false },
    });
    expect(JSON.stringify(res.body)).not.toContain("oldvalue");
  });

  it("PUT writes the values into the env file, keeps other lines, reloads, and never echoes the values", async () => {
    const res = await request(app())
      .put("/api/settings/secrets")
      .set(bearer(adminToken))
      .send({ BINANCE_API_KEY: API_KEY, BINANCE_API_SECRET: API_SECRET, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHANNEL_ID: CHANNEL })
      .expect(200);

    expect(res.body).toEqual({
      secrets: { BINANCE_API_KEY: true, BINANCE_API_SECRET: true, TELEGRAM_BOT_TOKEN: true, TELEGRAM_CHANNEL_ID: true },
    });
    const text = readFileSync(envFile, "utf8");
    expect(text).toContain("PORT=4000");
    expect(text).toContain("# keep this comment");
    expect(text).toContain(`BINANCE_API_KEY=${API_KEY}`); // replaced in place
    expect(text).not.toContain("oldvalue");
    expect(text).toContain(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`);
    expect(text.match(/BINANCE_API_KEY=/g)).toHaveLength(1);
    expect(fakeEnv.BINANCE_API_SECRET).toBe(API_SECRET); // process environment reloaded

    const responseText = JSON.stringify(res.body) + JSON.stringify(res.headers);
    for (const value of [API_KEY, API_SECRET, BOT_TOKEN, CHANNEL]) expect(responseText).not.toContain(value);
  });

  it("an empty string clears a secret", async () => {
    await request(app()).put("/api/settings/secrets").set(bearer(adminToken)).send({ BINANCE_API_KEY: "" }).expect(200);
    expect(readFileSync(envFile, "utf8")).toContain("BINANCE_API_KEY=\n");
    expect(fakeEnv.BINANCE_API_KEY).toBeUndefined();
    const status = await request(app()).get("/api/settings/secrets/status").set(bearer(adminToken)).expect(200);
    expect(status.body.secrets.BINANCE_API_KEY).toBe(false);
  });

  it("validates length and characters, without echoing the submitted value", async () => {
    const attempts: Array<Record<string, string>> = [
      { BINANCE_API_KEY: "short" },
      { BINANCE_API_KEY: "has spaces in it 12345678" },
      { BINANCE_API_SECRET: "newline\ninjection1234567890" },
      { BINANCE_API_KEY: "OK" + "x".repeat(200) },
      { TELEGRAM_BOT_TOKEN: "not-a-token-ZZsecretvalue" },
      { TELEGRAM_CHANNEL_ID: "channel name ZZsecretvalue" },
    ];
    for (const body of attempts) {
      const res = await request(app()).put("/api/settings/secrets").set(bearer(adminToken)).send(body).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(res.body)).not.toContain("ZZsecretvalue");
      expect(JSON.stringify(res.body)).not.toContain("injection");
    }
    await request(app()).put("/api/settings/secrets").set(bearer(adminToken)).send({ NODE_ENV: "production" }).expect(400); // only the four keys
    await request(app()).put("/api/settings/secrets").set(bearer(adminToken)).send({}).expect(400);
    expect(readFileSync(envFile, "utf8")).toContain("BINANCE_API_KEY=oldvalueoldvalueold1");
  });

  it("secret values never appear in any log line, for accepted, rejected and unauthorized requests", async () => {
    const a = app();
    await request(a).put("/api/settings/secrets").set(bearer(adminToken)).send({ BINANCE_API_KEY: API_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN }).expect(200);
    await request(a).put("/api/settings/secrets").set(bearer(adminToken)).send({ BINANCE_API_SECRET: "ZZsecretvalue bad" }).expect(400);
    await request(a).put("/api/settings/secrets").set(bearer(userToken)).send({ BINANCE_API_SECRET: API_SECRET }).expect(403);
    await request(a).put("/api/settings/secrets").send({ TELEGRAM_CHANNEL_ID: CHANNEL }).expect(401);
    await request(a).get("/api/settings/secrets/status").set(bearer(adminToken)).expect(200);

    expect(logLines.length).toBeGreaterThan(0); // the request logger did run
    const logs = logLines.join("\n");
    for (const value of [API_KEY, API_SECRET, BOT_TOKEN, CHANNEL, "ZZsecretvalue", adminToken, userToken]) {
      expect(logs).not.toContain(value);
    }
  });

  it("malformed JSON bodies do not leak the payload either", async () => {
    const res = await request(app())
      .put("/api/settings/secrets")
      .set(bearer(adminToken))
      .set("Content-Type", "application/json")
      .send(`{"BINANCE_API_KEY":"${API_KEY}`)
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
    expect(logLines.join("\n")).not.toContain(API_KEY);
  });
});

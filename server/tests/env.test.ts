import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "../src/config/env.js";

describe("env validation", () => {
  it("accepts an empty environment and applies defaults", () => {
    const env = parseEnv({ GOOGLE_WEB_CLIENT_ID: "web.apps.googleusercontent.com" });
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.ADMIN_USER_IDS).toEqual([]);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
  });

  it("treats empty optional values as unset and parses comma lists", () => {
    const env = parseEnv({ GOOGLE_WEB_CLIENT_ID: "web", PORT: "", TELEGRAM_BOT_TOKEN: "", CORS_ORIGINS: "http://a.test, http://b.test", ADMIN_USER_IDS: "1,2" });
    expect(env.PORT).toBe(4000);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
    expect(env.ADMIN_USER_IDS).toEqual(["1", "2"]);
  });

  it.each(["abc", "-1", "0", "70000", "40.5"])("rejects invalid PORT %s", (port) => {
    expect(() => parseEnv({ GOOGLE_WEB_CLIENT_ID: "web", PORT: port })).toThrow(EnvError);
  });

  it("requires JWT_SECRET in production only", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
    expect(parseEnv({ NODE_ENV: "production", GOOGLE_WEB_CLIENT_ID: "web", JWT_SECRET: "a-long-enough-secret-value" }).JWT_SECRET).toBeDefined();
    expect(() => parseEnv({ NODE_ENV: "development", GOOGLE_WEB_CLIENT_ID: "web" })).not.toThrow();
  });

  it("fails at startup with a clear message when GOOGLE_WEB_CLIENT_ID is empty", () => {
    expect(() => parseEnv({})).toThrow(/GOOGLE_WEB_CLIENT_ID.*required/);
    expect(() => parseEnv({ GOOGLE_WEB_CLIENT_ID: "" })).toThrow(EnvError);
    expect(() => parseEnv({ NODE_ENV: "production", JWT_SECRET: "a-long-enough-secret-value" })).toThrow(/GOOGLE_WEB_CLIENT_ID/);
  });

  it("does not need it in tests, with the development test login, or for offline tools", () => {
    expect(() => parseEnv({ NODE_ENV: "test" })).not.toThrow();
    expect(() => parseEnv({ ENABLE_DEV_LOGIN: "true" })).not.toThrow();
    expect(() => parseEnv({}, { skipAuthCheck: true })).not.toThrow();
  });

  it("ADMIN_EMAILS defaults to empty", () => {
    expect(parseEnv({ NODE_ENV: "test" }).ADMIN_EMAILS).toEqual([]);
  });
});

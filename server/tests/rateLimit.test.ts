import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";

describe("rate limiter", () => {
  const logger = createLogger({ level: "silent", pretty: false });

  it("returns 429 after 120 requests per minute on /api routes", async () => {
    const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0 });
    for (let i = 0; i < 120; i++) {
      await request(app).get("/api/meta").expect(200);
    }
    const res = await request(app).get("/api/meta").expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("does not limit /health", async () => {
    const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, rateLimit: { limit: 1 } });
    await request(app).get("/api/meta").expect(200);
    await request(app).get("/api/meta").expect(429);
    await request(app).get("/health").expect(200);
  });
});

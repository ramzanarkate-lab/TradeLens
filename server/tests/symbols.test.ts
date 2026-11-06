import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SYMBOLS, isSymbol, symbolSchema } from "../src/config/symbols.js";
import { createApp } from "../src/http/app.js";
import { AppError } from "../src/http/errors.js";
import { validate } from "../src/http/validate.js";
import { createLogger } from "../src/logging/logger.js";

describe("symbol validation", () => {
  it("accepts the allowed symbols", () => {
    expect(SYMBOLS).toEqual(["BTCUSDT", "SOLUSDT", "ETHUSDT"]);
    for (const s of SYMBOLS) expect(symbolSchema.safeParse(s).success).toBe(true);
  });

  it("rejects an unknown symbol like DOGEUSDT", () => {
    expect(symbolSchema.safeParse("DOGEUSDT").success).toBe(false);
    expect(isSymbol("DOGEUSDT")).toBe(false);
    expect(isSymbol("btcusdt")).toBe(false);
  });

  it("validate middleware answers 400 VALIDATION_ERROR for DOGEUSDT", async () => {
    const app = express();
    app.get("/x/:symbol", validate({ params: z.object({ symbol: symbolSchema }) }), (_req, res) => {
      res.json({ ok: true });
    });
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as AppError;
      res.status(e.status).json({ error: { code: e.code, message: e.message } });
    });

    await request(app).get("/x/BTCUSDT").expect(200);
    const res = await request(app).get("/x/DOGEUSDT").expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("http app", () => {
  const logger = createLogger({ level: "silent", pretty: false });
  const app = createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 3 });

  it("GET /health reports status, uptime and ws client count", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", wsClients: 3 });
    expect(typeof res.body.uptime).toBe("number");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /api/meta lists symbols and timeframes", async () => {
    const res = await request(app).get("/api/meta").expect(200);
    expect(res.body).toEqual({ symbols: ["BTCUSDT", "SOLUSDT", "ETHUSDT"], timeframes: ["15m", "1h", "4h", "1d"] });
  });

  it("unknown routes and bad JSON use the central error shape", async () => {
    const notFound = await request(app).get("/nope").expect(404);
    expect(notFound.body.error.code).toBe("NOT_FOUND");
    const bad = await request(app).post("/api/meta").set("Content-Type", "application/json").send("{oops").expect(400);
    expect(bad.body.error.code).toBe("INVALID_JSON");
  });
});

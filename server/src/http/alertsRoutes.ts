import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { classicPivots, PRICE_DECIMALS } from "../analysis/pivots.js";
import { requireAdmin } from "../auth/middleware.js";
import { symbolSchema, type Symbol } from "../config/symbols.js";
import type { Publisher } from "../market/service.js";
import type { PivotLevels, Signal } from "../types/index.js";
import { validate } from "./validate.js";

const testBody = z
  .object({
    symbol: symbolSchema.default("BTCUSDT"),
    side: z.enum(["BUY", "SELL"]).default("BUY"),
    price: z.number().positive().finite().optional(),
  })
  .strict();

/** Round-ish sample prices, used when the caller does not give one. */
const SAMPLE_PRICE: Record<Symbol, number> = { BTCUSDT: 67_420, SOLUSDT: 150, ETHUSDT: 3_200 };

export interface AlertsRouterDeps {
  hub: Publisher;
  /** Defaults to the current time. */
  now?: () => number;
}

/** Builds the sample signal. It is flagged `test: true`. */
export function makeTestSignal(body: z.infer<typeof testBody>, now: number): Signal {
  const price = body.price ?? SAMPLE_PRICE[body.symbol];
  const pivots: PivotLevels = classicPivots(price * 1.02, price * 0.98, price, PRICE_DECIMALS[body.symbol]);
  return {
    id: randomUUID(),
    symbol: body.symbol,
    side: body.side,
    timeframe: "1h",
    price,
    levels: { S1: pivots.S1, R2: pivots.R2, pivots },
    indicators: { emaFast: price, emaSlow: price, rsi: 50 },
    trigger: body.side === "BUY" ? "ema_cross_up" : "ema_cross_down",
    reason: `Test alert: this is a sample ${body.side} signal. No real signal was generated.`,
    createdAt: now,
    test: true,
    mode: "paper",
    score: 80,
    reasons: ["Test alert: this is a sample signal", "No real signal was generated", "Nothing was stored"],
    entry: price,
    sl: Math.round(price * (body.side === "BUY" ? 0.99 : 1.01) * 100) / 100,
    tp1: Math.round(price * (body.side === "BUY" ? 1.01 : 0.99) * 100) / 100,
    tp2: Math.round(price * (body.side === "BUY" ? 1.02 : 0.98) * 100) / 100,
    tp3: Math.round(price * (body.side === "BUY" ? 1.03 : 0.97) * 100) / 100,
    riskPercent: 1,
    rrTp1: 1,
    rrTp2: 2,
    rrTp3: 3,
    status: "OPEN",
    statusHistory: [{ status: "OPEN", at: now, price, resultR: null }],
    closedAt: null,
    resultR: null,
  };
}

export function createAlertsRouter({ hub, now = Date.now }: AlertsRouterDeps): Router {
  const router = Router();

  // Admin only. Sends the event to every connected device, but does NOT store the signal.
  router.post("/alerts/test", requireAdmin, validate({ body: testBody }), (req, res) => {
    const signal = makeTestSignal(req.body as z.infer<typeof testBody>, now());
    const delivered = hub.broadcast("signals", { event: "signal", signal });
    res.json({ signal, delivered });
  });

  return router;
}

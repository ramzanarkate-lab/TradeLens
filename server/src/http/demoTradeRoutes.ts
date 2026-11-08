import { Router } from "express";
import { requireAdmin, requireUser } from "../auth/middleware.js";
import type { DemoTrader } from "../demotrade/demoTrader.js";
import { AppError } from "./errors.js";

export interface DemoRouterDeps {
  demo: DemoTrader;
}

const timeLeft = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/**
 * The Demo account of the signed-in user (virtual money only). Reading and refilling need a sign-in and only ever touch
 * the caller's own account; the settings need an admin.
 */
export function createDemoRouter({ demo }: DemoRouterDeps): Router {
  const router = Router();

  router.get("/demo", requireUser, (req, res) => {
    res.json(demo.view(req.user!.id));
  });

  router.post("/demo/refill", requireUser, (req, res) => {
    const result = demo.refill(req.user!.id);
    if (!result.ok) {
      throw new AppError(429, "REFILL_TOO_SOON", `You can refill your demo balance again in ${timeLeft(result.secondsLeft)}.`);
    }
    res.json(demo.view(req.user!.id));
  });

  router.get("/demo/settings", requireAdmin, (_req, res) => {
    res.json({ settings: demo.settings() });
  });

  router.put("/demo/settings", requireAdmin, (req, res) => {
    try {
      res.json({ settings: demo.updateSettings((req.body ?? {}) as object) });
    } catch (err) {
      throw new AppError(400, "INVALID_SETTINGS", err instanceof Error ? err.message : "Invalid settings.");
    }
  });

  return router;
}

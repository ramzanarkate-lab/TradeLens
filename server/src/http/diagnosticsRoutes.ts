import { Router } from "express";
import { requireAdmin } from "../auth/middleware.js";
import type { DiagnosticsReport } from "../market/providerRegistry.js";

export interface DiagnosticsSource {
  report(): Promise<DiagnosticsReport>;
}

/** Admin only. Lists the providers, which of them answered right now, and the last 10 errors. Never any secret values. */
export function createDiagnosticsRouter(source: DiagnosticsSource): Router {
  const router = Router();
  router.get("/diagnostics", requireAdmin, async (_req, res, next) => {
    try {
      res.json(await source.report());
    } catch (err) {
      next(err);
    }
  });
  return router;
}

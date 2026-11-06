import { Router } from "express";
import type { DashboardService } from "../dashboard/service.js";

export function createDashboardRouter(dashboard: DashboardService): Router {
  const router = Router();
  router.get("/dashboard", (_req, res, next) => {
    dashboard.get().then((body) => res.json(body), next);
  });
  return router;
}

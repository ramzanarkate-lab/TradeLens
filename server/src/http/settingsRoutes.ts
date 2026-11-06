import { Router } from "express";
import { requireAdmin, requireUser } from "../auth/middleware.js";
import { describeIssues, SECTION_NAMES, type SectionName } from "../settings/schema.js";
import { SecretsService, secretsBodySchema } from "../settings/secrets.js";
import type { SettingsStore } from "../settings/store.js";
import { latestBacktest } from "../signals/backtestStore.js";
import { AppError } from "./errors.js";

export interface SettingsRouterDeps {
  settings: SettingsStore;
  secrets?: SecretsService;
  /** Folder with backtest reports (<symbol>-<date>.json). Without it, live mode can never be switched on. */
  backtestDir?: string;
}

export function createSettingsRouter({ settings, secrets, backtestDir }: SettingsRouterDeps): Router {
  const router = Router();

  // Guests (no token) see only the chart and alerts sections. Signed-in users see everything.
  router.get("/settings", (req, res) => {
    const all = settings.get();
    if (!req.user) {
      res.json({ role: "guest", settings: { chart: all.chart, alerts: all.alerts } });
      return;
    }
    res.json({ role: req.user.role, settings: all });
  });

  // Secrets: admin only. Values are never returned, only whether each one is set.
  if (secrets) {
    router.get("/settings/secrets/status", requireAdmin, (_req, res) => {
      res.json({ secrets: secrets.status() });
    });

    router.put("/settings/secrets", requireAdmin, async (req, res, next) => {
      const parsed = secretsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        // Issue messages describe the rule that failed, never the submitted value.
        return next(new AppError(400, "VALIDATION_ERROR", describeIssues(parsed.error, "secrets")));
      }
      try {
        await secrets.set(parsed.data);
        res.json({ secrets: secrets.status() });
      } catch {
        next(new AppError(500, "SECRETS_WRITE_FAILED", "Could not save the secrets."));
      }
    });
  }

  // Signal settings. Changing the mode is the publishing gate: admin only, and live needs a PASS backtest for every enabled symbol.
  router.put("/settings/signals", requireUser, (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === "object" && "mode" in body) {
      if (req.user!.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only an admin can change the signal mode.");
      if (body.mode === "live") {
        const missing = settings
          .get()
          .symbols.enabled.filter((symbol) => !backtestDir || latestBacktest(backtestDir, symbol)?.verdict !== "PASS");
        if (missing.length > 0) {
          throw new AppError(409, "BACKTEST_REQUIRED", `Live mode needs a PASS backtest for: ${missing.join(", ")}. Run "npm run backtest" for each symbol first.`);
        }
      }
    }
    const values = settings.update("signals", body);
    res.json({ section: "signals", values });
  });

  for (const section of SECTION_NAMES) {
    if (section === "signals") continue;
    router.put(`/settings/${section}`, requireUser, (req, res) => {
      const values = settings.update(section as SectionName, req.body);
      res.json({ section, values });
    });
  }

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import type { ProviderMode } from "../market/providerRegistry.js";
import type { SecretsService } from "../settings/secrets.js";
import { AppError } from "./errors.js";
import { validate } from "./validate.js";

const providerBody = z.object({ provider: z.enum(["auto", "bybit", "okx", "kraken", "binance"]) }).strict();

export interface AdminServerDeps {
  version: string;
  /** The market provider registry. Absent in offline demo mode. */
  registry?: {
    activeName: string;
    currentMode: ProviderMode;
    setMode(mode: ProviderMode): Promise<string>;
  };
  /** Live/Offline and per-symbol update times, as shown by /health. */
  market: () => { status: string; provider: string; lastPoll: Record<string, string | null> };
  telegram: () => { enabled: boolean; configured: boolean; lastSuccessAt: number | null; postsLast24h: number; failedPosts: number; abandonedPosts: number };
  secrets: SecretsService;
  /** GET /api/admin/runner: the last 20 runner events and Telegram results. */
  runnerReport?: () => { events: unknown[]; telegram: unknown[] };
  startedAt: number;
  now?: () => number;
}

/** Server settings for the admin screen. Admin only, and never any secret value. */
export function createAdminRouter(d: AdminServerDeps): Router {
  const router = Router();
  const now = d.now ?? Date.now;

  router.get("/admin/server", requireAdmin, (_req, res) => {
    const market = d.market();
    res.json({
      version: d.version,
      uptimeSeconds: Math.round((now() - d.startedAt) / 1000),
      marketProvider: { active: market.provider, setting: d.registry?.currentMode ?? "demo", live: market.status === "Live", status: market.status, lastPriceUpdate: market.lastPoll },
      telegram: d.telegram(),
    });
  });

  router.get("/admin/runner", requireAdmin, (_req, res, next) => {
    if (!d.runnerReport) return next(new AppError(404, "NOT_FOUND", "The signal runner is not running (offline demo mode)."));
    res.json(d.runnerReport());
  });

  router.put("/admin/server/market-provider", requireAdmin, validate({ body: providerBody }), async (req, res, next) => {
    if (!d.registry) return next(new AppError(409, "DEMO_MODE", "The market provider cannot be changed in offline demo mode."));
    const { provider } = req.body as z.infer<typeof providerBody>;
    try {
      await d.secrets.set({ MARKET_PROVIDER: provider }); // kept in the env file, so it survives a restart
      const active = await d.registry.setMode(provider);
      res.json({ setting: provider, active });
    } catch {
      next(new AppError(500, "PROVIDER_SWITCH_FAILED", "Could not switch the market provider."));
    }
  });

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import { symbolSchema } from "../config/symbols.js";
import type { NewsService } from "../news/service.js";
import type { FeedStatus } from "../news/sources.js";
import { validate } from "./validate.js";

const query = z.object({ symbol: symbolSchema.optional(), limit: z.coerce.number().int().min(1).max(50).default(50) });

/** Headlines a visitor may read: guests the newest 5, signed-in users up to 50. */
export const NEWS_ACCESS = { guest: 5, user: 50 } as const;

export interface NewsRouterDeps {
  service: NewsService;
  feeds: () => FeedStatus[];
  settings: () => { enabled: boolean; windowMinutes: number };
}

export function createNewsRouter(d: NewsRouterDeps): Router {
  const router = Router();

  router.get("/news", validate({ query }), (req, res) => {
    const q = req.query as unknown as z.infer<typeof query>;
    const cap = req.user ? NEWS_ACCESS.user : NEWS_ACCESS.guest;
    const items = d.service.recent(q.symbol, Math.min(q.limit, cap));
    res.json({
      news: items.map((i) => ({ headline: i.headline, source: i.source, link: i.link, publishedAt: new Date(i.publishedAt).toISOString(), score: i.score, symbols: i.symbols })),
      cap,
    });
  });

  router.get("/news/status", requireAdmin, (_req, res) => {
    const s = d.settings();
    res.json({
      status: d.service.healthStatus(s.enabled),
      enabled: s.enabled,
      windowMinutes: s.windowMinutes,
      feeds: d.feeds().map((f) => ({
        name: f.name,
        ok: f.ok,
        lastAttemptAt: f.lastAttemptAt ? new Date(f.lastAttemptAt).toISOString() : null,
        lastSuccessAt: f.lastSuccessAt ? new Date(f.lastSuccessAt).toISOString() : null,
        error: f.error,
      })),
    });
  });

  return router;
}

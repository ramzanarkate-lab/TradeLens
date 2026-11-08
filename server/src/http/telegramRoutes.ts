import { Router } from "express";
import { requireAdmin } from "../auth/middleware.js";
import type { Env } from "../config/env.js";
import type { TelegramClient } from "../telegram/telegramClient.js";
import type { TelegramStatus } from "../telegram/telegramNotifier.js";

export interface TelegramRouterDeps {
  /** Always the current environment (it follows PUT /api/settings/secrets). */
  env: () => Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHANNEL_ID" | "TELEGRAM_ENABLED" | "TELEGRAM_POST_DEMO" | "TELEGRAM_CHANNEL_LINK">;
  client: Pick<TelegramClient, "sendMessage">;
  notifier: { status(): TelegramStatus };
}

export function createTelegramRouter({ env, client, notifier }: TelegramRouterDeps): Router {
  const router = Router();

  // Everyone may read the basics. Admins also get the numbers. The token and channel ID are never returned.
  router.get("/telegram/status", (req, res) => {
    const e = env();
    const basics = {
      enabled: e.TELEGRAM_ENABLED,
      configured: Boolean(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHANNEL_ID),
      // the invite link is a free benefit of signing in: a guest (no session) does not get it
      channelLink: req.user ? (e.TELEGRAM_CHANNEL_LINK ?? "") : "",
    };
    if (req.user?.role !== "admin") return void res.json(basics);
    const s = notifier.status();
    res.json({ ...basics, postDemoEvents: e.TELEGRAM_POST_DEMO, lastSuccessAt: s.lastSuccessAt, postsLast24h: s.postsLast24h, failedPosts: s.failed, abandonedPosts: s.abandoned });
  });

  // Works before TELEGRAM_ENABLED is switched on, so an admin can check the token and channel first.
  router.post("/telegram/test", requireAdmin, async (_req, res) => {
    const result = await client.sendMessage("TradeLens Telegram test");
    res.json(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  return router;
}

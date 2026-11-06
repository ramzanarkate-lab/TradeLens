import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/auth.js";
import { requireAdmin, requireUser } from "../auth/middleware.js";
import type { UserStore } from "../auth/userStore.js";
import type { Logger } from "../logging/logger.js";
import { AppError } from "./errors.js";
import { validate } from "./validate.js";

const googleBody = z.object({ idToken: z.string().min(20).max(4096) }).strict();
const devBody = z
  .object({ userId: z.string().regex(/^[\w.-]{1,40}$/).default("dev-user"), name: z.string().max(60).optional() })
  .strict();
const proParams = z.object({ id: z.string().min(1).max(200) });
const proBody = z.object({ pro: z.boolean() }).strict();

export interface AuthRouterOptions {
  auth: AuthService;
  logger: Logger;
  /** True only when ENABLE_DEV_LOGIN=true and NODE_ENV=development. */
  devLogin: boolean;
  users?: UserStore;
}

export function createAuthRouter({ auth, logger, devLogin, users }: AuthRouterOptions): Router {
  const router = Router();

  router.post("/auth/google", validate({ body: googleBody }), async (req, res, next) => {
    if (!auth.googleEnabled) {
      return next(new AppError(503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is not configured on this server (set GOOGLE_WEB_CLIENT_ID)."));
    }
    try {
      const profile = await auth.verifyGoogle((req.body as z.infer<typeof googleBody>).idToken);
      res.json(auth.issue(profile));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "google token rejected");
      next(new AppError(401, "INVALID_GOOGLE_TOKEN", "Google sign-in failed. Please try again."));
    }
  });

  // Test-user login: absent (404) unless explicitly enabled for development.
  if (devLogin) {
    logger.warn("DEV LOGIN IS ENABLED: anyone who can reach this server can sign in as a test user");
    router.post("/auth/dev-login", validate({ body: devBody }), (req, res) => {
      const { userId, name } = req.body as z.infer<typeof devBody>;
      res.json(auth.issue({ id: userId, email: `${userId}@dev.local`, name: name ?? userId, emailVerified: true }));
    });
  }

  // Who am I? The role is computed now, from the current ADMIN_USER_IDS and pro flag.
  const me: import("express").RequestHandler = (req, res) => {
    const user = req.user!;
    res.json({ user: { id: user.id, email: user.email, name: user.name }, role: user.role, pro: user.pro });
  };
  router.get("/me", requireUser, me);
  router.get("/auth/me", requireUser, me); // earlier name, kept for the existing app version

  // Admin only: grant or remove the Pro tier.
  if (users) {
    router.put("/admin/users/:id/pro", requireAdmin, validate({ params: proParams, body: proBody }), (req, res, next) => {
      const { id } = req.params as z.infer<typeof proParams>;
      const { pro } = req.body as z.infer<typeof proBody>;
      const updated = users.setPro(id, pro);
      if (!updated) return next(new AppError(404, "USER_NOT_FOUND", "No user with that id has signed in yet."));
      res.json({ id: updated.id, email: updated.email, name: updated.name, pro: updated.pro });
    });
  }

  return router;
}

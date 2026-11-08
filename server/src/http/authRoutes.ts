import { Router } from "express";
import { z } from "zod";
import { GUEST_SESSION_SECONDS, type AuthService } from "../auth/auth.js";
import { requireUser } from "../auth/middleware.js";
import type { Logger } from "../logging/logger.js";
import { AppError } from "./errors.js";
import { validate } from "./validate.js";

const googleBody = z.object({ idToken: z.string().min(20).max(4096) }).strict();
const devBody = z
  .object({ userId: z.string().regex(/^[\w.-]{1,40}$/).default("dev-user"), name: z.string().max(60).optional() })
  .strict();

/** A random id the app makes once and keeps on the phone. */
const guestBody = z.object({ deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).strict();

export interface AuthRouterOptions {
  auth: AuthService;
  logger: Logger;
  /** True only when ENABLE_DEV_LOGIN=true and NODE_ENV=development. */
  devLogin: boolean;
}

export function createAuthRouter({ auth, logger, devLogin }: AuthRouterOptions): Router {
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

  // Guest login: no account needed. The guest gets a session of their own (user id "guest:<device id>"), so everything a signed-in
  // user can do works for them too, with their own Demo account. A guest is never an admin: only ids and verified emails the
  // operator lists are, and a guest has neither.
  router.post("/auth/guest", validate({ body: guestBody }), (req, res) => {
    const { deviceId } = req.body as z.infer<typeof guestBody>;
    res.json(auth.issue({ id: `guest:${deviceId}`, email: "", name: "Guest", emailVerified: false }, { ttlSeconds: GUEST_SESSION_SECONDS }));
  });

  // Test-user login: absent (404) unless explicitly enabled for development.
  if (devLogin) {
    logger.warn("DEV LOGIN IS ENABLED: anyone who can reach this server can sign in as a test user");
    router.post("/auth/dev-login", validate({ body: devBody }), (req, res) => {
      const { userId, name } = req.body as z.infer<typeof devBody>;
      res.json(auth.issue({ id: userId, email: `${userId}@dev.local`, name: name ?? userId, emailVerified: true }));
    });
  }

  // Who am I? The role is computed now, from the current admin lists.
  const me: import("express").RequestHandler = (req, res) => {
    const user = req.user!;
    res.json({ user: { id: user.id, email: user.email, name: user.name }, role: user.role });
  };
  router.get("/me", requireUser, me);
  router.get("/auth/me", requireUser, me); // earlier name, kept for the existing app version

  return router;
}

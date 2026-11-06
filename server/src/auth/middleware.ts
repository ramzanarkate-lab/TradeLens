import type { RequestHandler } from "express";
import { AppError } from "../http/errors.js";
import type { User } from "../types/index.js";
import type { AuthService } from "./auth.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set when a valid Bearer token was sent. Undefined = guest. */
    user?: User;
  }
}

/** Reads "Authorization: Bearer <token>". No header = guest; a bad or expired token = 401. */
export function authenticate(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const header = req.header("authorization");
    if (!header) return next();
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const user = match ? auth.verify(match[1]!) : null;
    if (!user) return next(new AppError(401, "INVALID_TOKEN", "Your session is invalid or has expired. Please sign in again."));
    req.user = user;
    next();
  };
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "Sign in to use this."));
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "Sign in to use this."));
  if (req.user.role !== "admin") return next(new AppError(403, "FORBIDDEN", "Admin access is required."));
  next();
};

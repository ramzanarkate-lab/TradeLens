import rateLimit from "express-rate-limit";

export interface RateLimitOptions {
  windowMs?: number;
  limit?: number;
}

/** 120 requests per minute per IP by default. */
export function createApiRateLimiter({ windowMs = 60_000, limit = 120 }: RateLimitOptions = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests, please slow down." } });
    },
  });
}

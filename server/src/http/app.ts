import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import helmet from "helmet";
import type { Env } from "../config/env.js";
import { SYMBOLS, TIMEFRAMES } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import { AppError } from "./errors.js";
import type { MarketService } from "../market/service.js";
import type { SignalStore } from "../signals/store.js";
import type { AuthService } from "../auth/auth.js";
import type { UserStore } from "../auth/userStore.js";
import { authenticate } from "../auth/middleware.js";
import type { SecretsService } from "../settings/secrets.js";
import type { SettingsStore } from "../settings/store.js";
import type { DashboardService } from "../dashboard/service.js";
import { createDashboardRouter } from "./dashboardRoutes.js";
import { createAlertsRouter } from "./alertsRoutes.js";
import type { Publisher } from "../market/service.js";
import { createTelegramRouter, type TelegramRouterDeps } from "./telegramRoutes.js";
import { createAdminRouter, type AdminServerDeps } from "./adminRoutes.js";
import { createDiagnosticsRouter, type DiagnosticsSource } from "./diagnosticsRoutes.js";
import { createAuthRouter } from "./authRoutes.js";
import { createSettingsRouter } from "./settingsRoutes.js";
import { createMarketRouter } from "./marketRoutes.js";
import { createSignalsRouter } from "./signalsRoutes.js";
import { createNewsRouter, type NewsRouterDeps } from "./newsRoutes.js";
import { createApiRateLimiter, type RateLimitOptions } from "./rateLimit.js";

export interface AppDeps {
  env: Pick<Env, "CORS_ORIGINS">;
  logger: Logger;
  /** Number of connected WebSocket clients, reported by /health. */
  clientCount: () => number;
  rateLimit?: RateLimitOptions;
  market?: MarketService;
  signals?: SignalStore;
  auth?: AuthService;
  /** Enables POST /api/auth/dev-login. The caller decides (ENABLE_DEV_LOGIN=true and NODE_ENV=development). */
  devLogin?: boolean;
  settings?: SettingsStore;
  secrets?: SecretsService;
  dashboard?: DashboardService;
  /** Where test alerts are broadcast (required for POST /api/alerts/test). */
  hub?: Publisher;
  /** Needed for PUT /api/admin/users/:id/pro. */
  users?: UserStore;
  /** Telegram status and test endpoints. */
  telegram?: TelegramRouterDeps;
  /** Live/Offline, active provider and last poll times for /health. */
  marketHealth?: () => MarketHealth;
  /** Admin server settings (GET /api/admin/server, PUT /api/admin/server/market-provider). */
  adminServer?: AdminServerDeps;
  /** Folder with backtest reports; live mode needs a PASS report here. */
  backtestDir?: string;
  /** Source for GET /api/diagnostics (admin only). */
  diagnostics?: DiagnosticsSource;
  /** Extra fields for /health: runnerStatus, lastCandleTime, lastSignalTime, telegramStatus. Never secrets. */
  healthExtra?: () => Record<string, unknown>;
  /** GET /api/news and GET /api/news/status. */
  news?: NewsRouterDeps;
}

export interface MarketHealth {
  status: "Live" | "Reconnecting" | "Offline";
  provider: string;
  /** ISO time of the last successful poll per symbol (null = never). Empty when the feed is a WebSocket. */
  lastPoll: Record<string, string | null>;
  /** Plain-English reason prices are missing; null while they are live. */
  reason?: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    id: string;
  }
}

const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header("x-request-id");
  req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
};

/** Fields reported by /health: activeProvider, lastPriceUpdate per symbol, live (an update in the last 15 seconds), reason. */
function marketHealthFields(m: MarketHealth) {
  const live = m.status === "Live";
  return {
    activeProvider: m.provider,
    lastPriceUpdate: m.lastPoll,
    live,
    reason: live ? null : (m.reason ?? "Waiting for the first price update"),
    market: m,
  };
}

export function createApp({ env, logger, clientCount, rateLimit, market, signals, auth, devLogin, settings, secrets, dashboard, hub, users, telegram, marketHealth, diagnostics, backtestDir, adminServer, healthExtra, news }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(helmet());
  // Empty CORS_ORIGINS = no cross-origin browser access (the Android app does not need CORS).
  app.use(cors({ origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false }));
  app.use(express.json({ limit: "100kb" }));
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      logger.info({ reqId: req.id, method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start }, "request");
    });
    next();
  });

  app.get("/health", (_req, res) => {
    // `time` is kept because the Android app's health check parses it.
    // status "ok" = the server is up. The market feed has its own Live/Offline status under `market`.
    res.json({
      status: "ok",
      time: new Date().toISOString(),
      uptime: process.uptime(),
      wsClients: clientCount(),
      ...(marketHealth ? marketHealthFields(marketHealth()) : {}),
      ...(healthExtra ? healthExtra() : {}),
    });
  });

  app.use("/api", createApiRateLimiter(rateLimit));
  if (auth) app.use("/api", authenticate(auth)); // sets req.user; no header = guest

  app.get("/api/meta", (_req, res) => {
    res.json({ symbols: SYMBOLS, timeframes: TIMEFRAMES });
  });
  if (market) app.use("/api", createMarketRouter(market));
  if (signals) app.use("/api", createSignalsRouter(signals));
  if (news) app.use("/api", createNewsRouter(news));
  if (dashboard) app.use("/api", createDashboardRouter(dashboard));
  if (auth && hub) app.use("/api", createAlertsRouter({ hub }));
  if (auth) app.use("/api", createAuthRouter({ auth, logger, devLogin: devLogin === true, users }));
  if (auth && telegram) app.use("/api", createTelegramRouter(telegram));
  if (auth && adminServer) app.use("/api", createAdminRouter(adminServer));
  if (auth && diagnostics) app.use("/api", createDiagnosticsRouter(diagnostics));
  if (settings) app.use("/api", createSettingsRouter({ settings, secrets, backtestDir }));

  app.use((req, _res, next) => next(new AppError(404, "NOT_FOUND", `Route ${req.method} ${req.path} not found`)));

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "Something went wrong.";

    if (err instanceof AppError) {
      ({ status, code, message } = { status: err.status, code: err.code, message: err.message });
    } else if (err?.type === "entity.too.large") {
      status = 413;
      code = "PAYLOAD_TOO_LARGE";
      message = "Request body is too large.";
    } else if (err?.type === "entity.parse.failed") {
      status = 400;
      code = "INVALID_JSON";
      message = "Request body is not valid JSON.";
    }

    if (status >= 500) logger.error({ err, reqId: req.id }, "unhandled error");
    res.status(status).json({ error: { code, message } });
  };
  app.use(errorHandler);

  return app;
}

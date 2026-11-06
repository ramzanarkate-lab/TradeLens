import "dotenv/config";
import { config as loadEnvFile } from "dotenv";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import pino from "pino";
import { AuthService, createGoogleVerifier } from "./auth/auth.js";
import { liveEnvList } from "./auth/liveEnvList.js";
import { UserStore } from "./auth/userStore.js";
import { EnvError, parseEnv } from "./config/env.js";
import { DashboardService } from "./dashboard/service.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./logging/logger.js";
import { DemoRest } from "./demo/demoRest.js";
import { BinanceStream, buildStreamUrl, type MarketFeed } from "./market/binanceWs.js";
import { MarketPoller } from "./market/poller.js";
import { ProviderRegistry, redactEnvSecrets } from "./market/providerRegistry.js";
import { BinanceProvider } from "./market/providers/binance.js";
import { BybitProvider } from "./market/providers/bybit.js";
import { KrakenProvider } from "./market/providers/kraken.js";
import { OkxProvider } from "./market/providers/okx.js";
import { CandleCache } from "./market/cache.js";
import { MarketService } from "./market/service.js";
import { SecretsService } from "./settings/secrets.js";
import { SettingsStore, StoreSignalSettings, type SettingsChange } from "./settings/store.js";
import { SignalServiceV2 } from "./signals/service.v2.js";
import { SignalStore } from "./signals/store.js";
import { TelegramClient } from "./telegram/telegramClient.js";
import { TelegramPoster } from "./telegram/telegramPoster.js";
import { NewsService } from "./news/service.js";
import { RuleBasedScorer, loadKeywords } from "./news/sentiment.js";
import { loadFeeds, NewsFetcher } from "./news/sources.js";
import { installProcessGuards } from "./runner/processGuards.js";
import { SignalRunner } from "./runner/signalRunner.js";
import { Watchdog } from "./runner/watchdog.js";
import { WsHub } from "./ws/hub.js";

// Values saved from the app (PUT /api/settings/secrets) live in ENV_FILE; load them so they survive a restart.
if (process.env.ENV_FILE) loadEnvFile({ path: process.env.ENV_FILE, override: true });

let env;
try {
  env = parseEnv();
} catch (err) {
  console.error(err instanceof EnvError ? err.message : err);
  process.exit(1);
}

const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === "development" });
// Never let one stray error take the 24/7 server down: log it and keep running.
installProcessGuards(logger);
const hub = new WsHub({ logger });

// Demo mode: sample data from `npm run seed`, no live feed, no network calls to the provider.
const demoDir = resolve(env.DATA_DIR, "demo");
// Live data: the provider registry picks Binance, Bybit, OKX or Kraken (MARKET_PROVIDER) and fails over if one is blocked.
const registry = env.DEMO_MODE
  ? undefined
  : new ProviderRegistry({
      mode: env.MARKET_PROVIDER,
      providers: [new BinanceProvider({ baseUrl: env.MARKET_DATA_BASE_URL }), new BybitProvider(), new OkxProvider(), new KrakenProvider()],
      logger,
      redact: redactEnvSecrets,
    });
await registry?.init(); // logs the chosen provider once
const useWebSocket = env.MARKET_STREAM === "websocket" && registry?.activeName === "binance";
if (env.MARKET_STREAM === "websocket" && !useWebSocket && registry) {
  logger.warn({ provider: registry.activeName }, "MARKET_STREAM=websocket needs the Binance provider: using polling instead");
}
const poller =
  registry && env.MARKET_WS_ENABLED && !useWebSocket
    ? new MarketPoller({ source: registry, logger, symbols: () => settingsStore.get().symbols.enabled })
    : undefined;
const stream: MarketFeed | undefined =
  env.MARKET_WS_ENABLED && !env.DEMO_MODE
    ? useWebSocket
      ? new BinanceStream({ url: buildStreamUrl(env.MARKET_DATA_WS_URL), logger })
      : poller
    : undefined;
const market = new MarketService({
  rest: registry ?? new DemoRest(resolve(demoDir, "candles.json")),
  cache: new CandleCache(),
  stream,
  hub,
  logger,
});

// Settings: the signal engine reads them on every candle, so edits apply without a restart.
const settingsStore = new SettingsStore(resolve(env.DATA_DIR, "settings.json"), logger);
settingsStore.load();
settingsStore.on("changed", ({ section, at }: SettingsChange) => {
  // Only the section name goes out: the topic is not authenticated, so clients re-fetch GET /api/settings.
  hub.broadcast("settings", { event: "changed", section, at });
  logger.info({ section }, "settings changed");
});
const signalSettings = new StoreSignalSettings(settingsStore);

const signalStore = new SignalStore(resolve(env.DEMO_MODE ? demoDir : env.DATA_DIR, "signals.json"), logger);
signalStore.load();
// News: public RSS headlines (no article text). They can add points to, or block, a signal the engine already has.
const newsFetcher = env.DEMO_MODE
  ? undefined
  : new NewsFetcher({ feeds: loadFeeds(new URL("../config/news-sources.json", import.meta.url)), file: resolve(env.DATA_DIR, "news.json"), logger });
const newsService = newsFetcher
  ? new NewsService({
      fetcher: newsFetcher,
      scorer: new RuleBasedScorer(
        (() => {
          try {
            return loadKeywords(new URL("../config/news-keywords.json", import.meta.url));
          } catch {
            return { bullish: [], bearish: [], negations: ["not", "no", "fails to"] };
          }
        })(),
      ),
      logger,
    })
  : undefined;
const newsSettings = () => {
  const s = signalSettings.get();
  return { enabled: s.newsEnabled, windowMinutes: s.newsWindowMinutes, boostPoints: s.newsBoostPoints, vetoEnabled: s.newsVetoEnabled };
};
const signalService = stream
  ? new SignalServiceV2({
      market,
      stream,
      store: signalStore,
      settings: signalSettings,
      hub,
      logger,
      hourlyFromStream: false, // the SignalRunner decides when a closed candle is evaluated
      news: newsService ? (symbol, side, s) => newsService.evaluate(symbol, side, { enabled: s.newsEnabled, windowMinutes: s.newsWindowMinutes, boostPoints: s.newsBoostPoints, vetoEnabled: s.newsVetoEnabled }) : undefined,
    })
  : undefined;
const runner = signalService
  ? new SignalRunner({
      service: signalService,
      market,
      prices: poller,
      settings: signalSettings,
      logger,
      stateFile: resolve(env.DATA_DIR, "runner-state.json"),
      lastSignalAt: signalStore.all().reduce<number | null>((m, s) => (m === null || s.createdAt > m ? s.createdAt : m), null),
    })
  : undefined;
const pollerStartedAt = Date.now();
const watchdog = new Watchdog({
  logger,
  parts: [
    ...(runner ? [{ name: "signal runner", lastActivity: () => runner.lastActivity(), restart: (reason: string) => runner.restart(reason) }] : []),
    ...(poller
      ? [
          {
            name: "price poller",
            lastActivity: () => Math.max(pollerStartedAt, ...Object.values(poller.lastPolls()).map((t) => t ?? 0)),
            restart: () => {
              poller.stop();
              poller.start();
            },
          },
        ]
      : []),
  ],
});

// Auth: Google ID tokens (needs GOOGLE_WEB_CLIENT_ID) and, in development only, an opt-in test login.
const DEV_JWT_SECRET = "tradelens-dev-only-secret-do-not-use-in-production";
const userStore = new UserStore(resolve(env.DATA_DIR, "users.json"), logger);
userStore.load();
const auth = new AuthService({
  secret: env.JWT_SECRET ?? DEV_JWT_SECRET,
  adminIds: () => env.ADMIN_USER_IDS,
  // Re-read from the env file when it changes, so removing an email applies to the next request.
  adminEmails: liveEnvList(resolve(env.ENV_FILE ?? ".env"), "ADMIN_EMAILS", () => secrets.reloadedEnv.ADMIN_EMAILS),
  verifyGoogle: env.GOOGLE_WEB_CLIENT_ID ? await createGoogleVerifier(env.GOOGLE_WEB_CLIENT_ID) : undefined,
  users: userStore,
});
if (env.DEMO_MODE) logger.warn("DEMO_MODE is on: all market data and signals are sample data");
if (!env.JWT_SECRET) logger.warn("JWT_SECRET is not set: using an insecure development secret");
const devLogin = env.ENABLE_DEV_LOGIN && env.NODE_ENV === "development";

const secrets = new SecretsService(resolve(env.ENV_FILE ?? ".env"));

// Telegram: reads the live environment on every post, so a new token or channel from the app applies at once.
const startedAt = Date.now();
const telegramEnv = () => secrets.reloadedEnv;
const telegramClient = new TelegramClient({
  credentials: () => {
    const e = telegramEnv();
    return e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHANNEL_ID ? { token: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHANNEL_ID } : undefined;
  },
});
const telegramLog = pino({ level: "info" }, pino.destination({ dest: resolve("logs", "telegram.log"), mkdir: true, sync: false }));
const telegramPoster = new TelegramPoster({
  client: telegramClient,
  enabled: () => {
    const e = telegramEnv();
    return e.TELEGRAM_ENABLED && Boolean(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHANNEL_ID);
  },
  timeZone: () => telegramEnv().TELEGRAM_TIMEZONE,
  strategy: () => {
    const s = signalSettings.get();
    return { emaFast: s.emaFast, emaSlow: s.emaSlow, rsiPeriod: s.rsiPeriod };
  },
  sentFile: resolve(env.DATA_DIR, "telegram-sent.json"),
  failedFile: resolve(env.DATA_DIR, "telegram-failed.json"),
  log: telegramLog,
  startedAt,
});
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) logger.info("Telegram disabled: not configured");
else if (!env.TELEGRAM_ENABLED) logger.info("Telegram disabled: TELEGRAM_ENABLED is not true");
signalService?.onSignal((signal) => void telegramPoster.handle(signal));
signalService?.onUpdate((signal, change) => void telegramPoster.handleUpdate(signal, change));

const packageVersion = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const telegramState = (): "active" | "disabled" | "not configured" => {
  const e = telegramEnv();
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_CHANNEL_ID) return "not configured";
  return e.TELEGRAM_ENABLED ? "active" : "disabled";
};

const app = createApp({
  healthExtra: () => ({
    runnerStatus: runner?.runnerStatus() ?? "stopped",
    lastCandleTime: runner?.lastCandleTimes() ?? {},
    lastSignalTime: runner?.lastSignalTime() ?? null,
    telegramStatus: telegramState(),
    newsStatus: newsService ? newsService.healthStatus(newsSettings().enabled) : "off",
  }),
  news: newsService && newsFetcher ? { service: newsService, feeds: () => newsFetcher.feedStatus(), settings: () => ({ enabled: newsSettings().enabled, windowMinutes: newsSettings().windowMinutes }) } : undefined,
  adminServer: {
    runnerReport: runner ? () => ({ events: runner.events(), telegram: telegramPoster.recentResults() }) : undefined,
    version: packageVersion,
    registry,
    startedAt,
    secrets,
    market: () => ({
      status: env.DEMO_MODE ? "Live" : (stream?.getStatus() ?? "Offline"),
      provider: registry?.activeName ?? "demo",
      lastPoll: Object.fromEntries(Object.entries(poller?.lastPolls() ?? {}).map(([s, t]) => [s, t ? new Date(t).toISOString() : null])),
    }),
    telegram: () => {
      const e = telegramEnv();
      const s = telegramPoster.status();
      return {
        enabled: e.TELEGRAM_ENABLED,
        configured: Boolean(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHANNEL_ID),
        lastSuccessAt: s.lastSuccessAt,
        postsLast24h: s.postsLast24h,
        failedPosts: s.failed,
        abandonedPosts: s.abandoned,
      };
    },
  },
  backtestDir: resolve(env.DATA_DIR, "backtests"),
  marketHealth: () => ({
    status: env.DEMO_MODE ? "Live" : (stream?.getStatus() ?? "Offline"),
    provider: registry?.activeName ?? "demo",
    lastPoll: Object.fromEntries(Object.entries(poller?.lastPolls() ?? {}).map(([s, t]) => [s, t ? new Date(t).toISOString() : null])),
    reason: registry?.failureReason() ?? null,
  }),
  diagnostics: registry ? { report: () => registry.diagnostics() } : undefined,
  telegram: { env: telegramEnv, client: telegramClient, poster: telegramPoster },
  env,
  logger,
  clientCount: () => hub.clientCount(),
  market,
  signals: signalStore,
  auth,
  devLogin,
  settings: settingsStore,
  secrets,
  hub,
  users: userStore,
  dashboard: new DashboardService({ market, settings: settingsStore, signals: signalStore, logger }),
});
const server = createServer(app);
hub.attach(server);

server.listen(env.PORT, () => {
  logger.info(`TradeLens server listening on http://localhost:${env.PORT} (ws path /ws)`);
  market.start();
  signalService?.start();
  runner?.start();
  newsFetcher?.start();
  watchdog.start();
  telegramPoster.start();
  stream?.start();
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  stream?.stop();
  runner?.stop();
  newsFetcher?.stop();
  watchdog.stop();
  telegramPoster.stop();
  await hub.close();
  await Promise.all([signalStore.flush(), settingsStore.flush(), userStore.flush()]);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

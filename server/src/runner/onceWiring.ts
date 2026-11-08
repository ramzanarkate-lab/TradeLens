import { resolve } from "node:path";
import type { Env } from "../config/env.js";
import { CHANNEL_ACCOUNT, DemoTrader } from "../demotrade/demoTrader.js";
import type { Logger } from "../logging/logger.js";
import { CandleCache } from "../market/cache.js";
import { ProviderRegistry, redactEnvSecrets } from "../market/providerRegistry.js";
import { BinanceProvider } from "../market/providers/binance.js";
import { BybitProvider } from "../market/providers/bybit.js";
import { KrakenProvider } from "../market/providers/kraken.js";
import { OkxProvider } from "../market/providers/okx.js";
import { MarketService } from "../market/service.js";
import { NewsService } from "../news/service.js";
import { loadKeywords, RuleBasedScorer } from "../news/sentiment.js";
import { loadFeeds, NewsFetcher } from "../news/sources.js";
import { SettingsStore, StoreSignalSettings } from "../settings/store.js";
import { SignalServiceV2 } from "../signals/service.v2.js";
import { SignalStore } from "../signals/store.js";
import { FileMirror, STORED_DOCUMENTS, STORED_FOLDERS, type Store } from "../storage/index.js";
import { StrategyBacktestStore, strategyPassed } from "../strategies/backtestStore.js";
import { StrategyRunner, StrategySignalGenerator } from "../strategies/generator.js";
import { STRATEGIES } from "../strategies/library.js";
import { createRouting } from "../strategies/routing.js";
import { StrategySignalStore } from "../strategies/signalStore.js";
import { TelegramClient } from "../telegram/telegramClient.js";
import { TelegramNotifier } from "../telegram/telegramNotifier.js";
import { announceTradeEvent } from "../telegram/tradeEvents.js";
import { isFreshSignal, telegramStoreAllowsPosting, type OnceSteps } from "./engineOnce.js";
import { SignalRunner } from "./signalRunner.js";

/**
 * The real steps of a one-shot run. They build the same parts as src/index.ts (the market data, the signal engine, the strategy
 * library, the demo accounts, the Telegram notifier) and call the single-pass `tick()` of the signal runner and of the strategy
 * runner once each. There is no server, no WebSocket and no timer: prices are not polled, so stops and targets are found on the
 * candle closes of each run.
 */
export function createOnceSteps(env: Env, store: Store, logger: Logger, now: () => number = Date.now): OnceSteps {
  if (env.DEMO_MODE) throw new Error("DEMO_MODE is not supported by the one-shot run");
  const dataDir = resolve(env.DATA_DIR);
  const mirror = store.kind === "supabase" ? new FileMirror({ store, dir: dataDir, keys: STORED_DOCUMENTS, folders: STORED_FOLDERS, logger, intervalMs: 2_000 }) : undefined;

  // built in run(), after the data has been restored: the stores read their files when they are created
  let notifier: TelegramNotifier | undefined;
  let signalStore: SignalStore | undefined;
  let settingsStore: SettingsStore | undefined;

  return {
    async hydrate() {
      if (!mirror) return;
      await mirror.hydrate(); // throws if the store cannot be read: nothing runs and nothing is saved
      mirror.start(); // changed files are uploaded every 2 seconds, so a sent-event id is saved right away
    },

    async run() {
      const settings = new SettingsStore(resolve(dataDir, "settings.json"), logger);
      settings.load();
      settingsStore = settings;
      const signalSettings = new StoreSignalSettings(settings);

      const registry = new ProviderRegistry({
        mode: env.MARKET_PROVIDER,
        providers: [new BinanceProvider({ baseUrl: env.MARKET_DATA_BASE_URL }), new BybitProvider(), new OkxProvider(), new KrakenProvider()],
        logger,
        redact: redactEnvSecrets,
      });
      await registry.init();
      const market = new MarketService({ rest: registry, cache: new CandleCache(), stream: undefined, logger });

      const signals = new SignalStore(resolve(dataDir, "signals.json"), logger);
      signals.load();
      signalStore = signals;

      // News: the same filter as the server, from one fetch
      const fetcher = new NewsFetcher({ feeds: loadFeeds(new URL("../../config/news-sources.json", import.meta.url)), file: resolve(dataDir, "news.json"), logger });
      await fetcher.pollOnce();
      const newsService = new NewsService({
        fetcher,
        scorer: new RuleBasedScorer(
          (() => {
            try {
              return loadKeywords(new URL("../../config/news-keywords.json", import.meta.url));
            } catch {
              return { bullish: [], bearish: [], negations: ["not", "no", "fails to"] };
            }
          })(),
        ),
        logger,
      });

      const signalService = new SignalServiceV2({
        market,
        stream: { on: () => undefined }, // no live stream in a one-shot run
        store: signals,
        settings: signalSettings,
        logger,
        hourlyFromStream: false,
        news: (symbol, side, s) => newsService.evaluate(symbol, side, { enabled: s.newsEnabled, windowMinutes: s.newsWindowMinutes, boostPoints: s.newsBoostPoints, vetoEnabled: s.newsVetoEnabled }),
      });

      // Telegram: the sent-event ids are checked before every send (see TelegramNotifier). They are kept in Supabase between runs.
      const storeCheck = telegramStoreAllowsPosting(store.kind);
      if (!storeCheck.allowed) logger.warn(storeCheck.reason);
      const client = new TelegramClient({
        credentials: () => (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHANNEL_ID ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHANNEL_ID } : undefined),
      });
      const tg = new TelegramNotifier({
        client,
        enabled: () => storeCheck.allowed && env.TELEGRAM_ENABLED && Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHANNEL_ID),
        postDemoEvents: () => env.TELEGRAM_POST_DEMO,
        allowLive: () => {
          const s = signalSettings.get();
          return s.mode === "live" || s.telegramPostPaper;
        },
        timeZone: () => env.TELEGRAM_TIMEZONE,
        sentFile: resolve(dataDir, "telegram-events-sent.json"),
        failedFile: resolve(dataDir, "telegram-events-failed.json"),
        log: logger,
        now,
      });
      notifier = tg;

      // Demo accounts and the strategy library, wired as in src/index.ts
      const demo = new DemoTrader({
        file: resolve(dataDir, "demo-accounts.json"),
        logger,
        activeSignals: () => signals.active().filter((s) => !s.test),
        channelAccepts: (signal) => isFreshSignal(signal.createdAt, now()),
      });
      signalService.onSignal((signal) => demo.onSignal(signal));
      signalService.onUpdate((signal) => demo.onUpdate(signal));
      signalService.onBar((symbol, bar) => demo.onBar(symbol, bar));
      demo.onEvent((userId, trade, event) => {
        void announceTradeEvent(tg, trade, event, userId === CHANNEL_ACCOUNT ? "live" : "demo", signalSettings.get().timeStopHours);
      });
      signalService.onSignal((signal) => {
        if (isFreshSignal(signal.createdAt, now())) void tg.newSignal(signal); // an old signal is never posted
      });

      const backtests = new StrategyBacktestStore(resolve(dataDir, "strategy-backtests.json"));
      const strategySignals = new StrategySignalStore(resolve(dataDir, "strategy-signals.json"), logger);
      strategySignals.load();
      const generator = new StrategySignalGenerator({
        strategies: STRATEGIES,
        store: strategySignals,
        passed: (strategyId, symbol, timeframe) => strategyPassed(backtests, strategyId, symbol, timeframe),
        hooks: createRouting({ telegram: tg, demo }, logger),
        logger,
        stateFile: resolve(dataDir, "strategy-runner-state.json"),
        now,
      });

      const signalRunner = new SignalRunner({
        service: signalService,
        market,
        settings: signalSettings,
        logger,
        stateFile: resolve(dataDir, "runner-state.json"),
        now,
      });
      const strategyRunner = new StrategyRunner({ generator, strategies: STRATEGIES, symbols: () => signalSettings.get().enabledSymbols, market, logger });

      await tg.retryFailed(); // messages an earlier run could not send
      await signalRunner.tick(); // one pass over the enabled symbols
      await strategyRunner.tick(); // one pass over every symbol and timeframe
      logger.info("signal cycle finished");
    },

    async settle() {
      await notifier?.idle(); // every Telegram send, so its id is saved before the data is
      await Promise.all([signalStore?.flush(), settingsStore?.flush()]);
      await mirror?.flush(); // a last upload of every changed file; there is no Supabase client to close (it is plain HTTPS requests)
    },
  };
}

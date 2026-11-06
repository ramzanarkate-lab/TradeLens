import type { KlineInterval, Symbol } from "../config/symbols.js";
import type { Logger } from "../logging/logger.js";
import type { Candle } from "../types/index.js";
import { MarketDataError, type Ticker24h } from "./binanceRest.js";
import { PROVIDER_NAMES, type MarketProvider, type PingResult, type ProviderName } from "./providers/types.js";
import { redactToken } from "../telegram/telegramClient.js";

export type ProviderMode = "auto" | ProviderName;
export const PROVIDER_MODES = ["auto", ...PROVIDER_NAMES] as const;

/** Order tried in auto mode. Binance is last because many server regions block it. */
export const AUTO_ORDER: readonly ProviderName[] = ["bybit", "okx", "kraken", "binance"];
export const FAILURES_BEFORE_SWITCH = 3;
const MAX_ERRORS = 10;

const SECRET_ENV_KEYS = ["JWT_SECRET", "BINANCE_API_KEY", "BINANCE_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID", "GOOGLE_WEB_CLIENT_ID"];

/** Replaces the current value of every secret environment variable in `text` (used for diagnostics). */
export function redactEnvSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (value && value.length >= 6) out = out.split(value).join("<redacted>");
  }
  return out;
}

export interface RecordedError {
  at: number;
  provider: ProviderName;
  message: string;
}

export interface DiagnosticsReport {
  mode: ProviderMode;
  active: ProviderName;
  providers: Array<{ name: ProviderName; reachable: boolean; status: number | null; latencyMs: number | null; testedAt: string; detail: string; active: boolean }>;
  errors: Array<{ at: string; provider: ProviderName; message: string }>;
}

export interface ProviderRegistryOptions {
  mode: ProviderMode;
  providers: MarketProvider[];
  logger: Logger;
  /** Removes secret values from error text before it is stored or returned. */
  redact?: (text: string) => string;
  failuresBeforeSwitch?: number;
  now?: () => number;
}

/** True for the failures that justify switching provider: blocked (403/451) or unreachable. */
function isSwitchable(err: unknown): boolean {
  return err instanceof MarketDataError && (err.code === "MARKET_DATA_BLOCKED" || err.code === "MARKET_DATA_UNAVAILABLE");
}

/**
 * Picks the market data provider and fails over between them. It has the same two methods the market service
 * already uses (fetchKlines, fetchTicker24h), so nothing else needs to know which provider is active.
 */
export class ProviderRegistry {
  private ordered: MarketProvider[];
  private mode: ProviderMode;
  private index = 0;
  private consecutiveFailures = 0;
  private lastFailureCode: string | null = null;
  private readonly errors: RecordedError[] = [];
  private readonly now: () => number;
  private readonly threshold: number;

  constructor(private readonly opts: ProviderRegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.threshold = opts.failuresBeforeSwitch ?? FAILURES_BEFORE_SWITCH;
    this.mode = opts.mode;
    this.ordered = this.order(opts.mode);
  }

  private order(mode: ProviderMode): MarketProvider[] {
    const byName = new Map(this.opts.providers.map((p) => [p.name, p]));
    if (mode === "auto") {
      const order = AUTO_ORDER.map((n) => byName.get(n)).filter((p): p is MarketProvider => Boolean(p));
      return order.length > 0 ? order : [...this.opts.providers];
    }
    const chosen = byName.get(mode);
    if (!chosen) throw new Error(`Unknown market provider "${mode}"`);
    return [chosen];
  }

  get currentMode(): ProviderMode {
    return this.mode;
  }

  /** Switches the provider setting without a restart ("auto" picks the first that answers). Returns the provider now in use. */
  async setMode(mode: ProviderMode): Promise<ProviderName> {
    this.ordered = this.order(mode);
    this.mode = mode;
    this.index = 0;
    this.consecutiveFailures = 0;
    this.lastFailureCode = null;
    return this.init();
  }

  get activeName(): ProviderName {
    return this.ordered[this.index]!.name;
  }

  /** Auto mode: pings the providers in order and starts with the first that answers. Logs the choice once. */
  async init(): Promise<ProviderName> {
    if (this.mode === "auto") {
      for (let i = 0; i < this.ordered.length; i++) {
        const result = await this.ordered[i]!.ping();
        if (result.ok) {
          this.index = i;
          break;
        }
        this.record(this.ordered[i]!.name, `startup check failed: ${result.detail}`);
      }
    }
    this.opts.logger.info({ provider: this.activeName, mode: this.mode }, `market provider: ${this.activeName}`);
    return this.activeName;
  }

  fetchKlines(symbol: Symbol, interval: KlineInterval, limit: number): Promise<Candle[]> {
    return this.run((p) => p.getCandles(symbol, interval, limit));
  }

  fetchTicker24h(symbol: Symbol): Promise<Ticker24h> {
    return this.run(async (p) => ({ symbol, ...(await p.getTicker(symbol)) }));
  }

  private async run<T>(call: (provider: MarketProvider) => Promise<T>): Promise<T> {
    const provider = this.ordered[this.index]!;
    try {
      const result = await call(provider);
      this.consecutiveFailures = 0;
      this.lastFailureCode = null;
      return result;
    } catch (err) {
      this.record(provider.name, err instanceof Error ? err.message : String(err));
      this.lastFailureCode = err instanceof MarketDataError ? err.code : "ERROR";
      if (!isSwitchable(err)) throw err;
      this.consecutiveFailures++;
      if (this.mode !== "auto" || this.ordered.length < 2 || this.consecutiveFailures < this.threshold) throw err;

      const from = provider.name;
      this.index = (this.index + 1) % this.ordered.length;
      this.consecutiveFailures = 0;
      this.opts.logger.warn({ from, to: this.activeName, after: this.threshold }, `market provider switched from ${from} to ${this.activeName}`);
      // Give the request that triggered the switch one try on the new provider.
      const next = this.ordered[this.index]!;
      try {
        const result = await call(next);
        return result;
      } catch (err2) {
        this.record(next.name, err2 instanceof Error ? err2.message : String(err2));
        throw err2;
      }
    }
  }

  private record(provider: ProviderName, message: string): void {
    const clean = (this.opts.redact ?? ((t: string) => t))(redactToken(message)).slice(0, 300);
    this.errors.push({ at: this.now(), provider, message: clean });
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
  }

  /** A short, plain reason why prices are not coming in, or null when the last request worked. No secret values. */
  failureReason(): string | null {
    switch (this.lastFailureCode) {
      case null:
        return null;
      case "MARKET_DATA_BLOCKED":
        return "Market data blocked from this server";
      case "MARKET_DATA_UNAVAILABLE":
        return "Market data provider unreachable from this server";
      default:
        return "Market data provider returned an unexpected answer";
    }
  }

  /** Pings every provider now (for GET /api/diagnostics) and lists the last 10 errors. No secret values are included. */
  async diagnostics(): Promise<DiagnosticsReport> {
    const pings = await Promise.all(
      this.ordered.map(async (p): Promise<[MarketProvider, PingResult]> => [p, await p.ping()]),
    );
    return {
      mode: this.mode,
      active: this.activeName,
      providers: pings.map(([p, r]) => ({
        name: p.name,
        reachable: r.ok,
        status: r.status ?? null,
        latencyMs: r.latencyMs ?? null,
        testedAt: new Date(r.at ?? this.now()).toISOString(),
        detail: r.detail,
        active: p.name === this.activeName,
      })),
      errors: this.errors.map((e) => ({ at: new Date(e.at).toISOString(), provider: e.provider, message: e.message })),
    };
  }
}

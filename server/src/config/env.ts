import { z } from "zod";

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Empty strings in .env (e.g. `TELEGRAM_BOT_TOKEN=`) count as "not set". */
const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(4000)),
    CORS_ORIGINS: z.string().default("").transform(csv),
    ADMIN_USER_IDS: z.string().default("").transform(csv),
    /** Verified Google emails that get the admin role, comma-separated, compared ignoring case. */
    ADMIN_EMAILS: z.string().default("").transform((v) => csv(v).map((e) => e.toLowerCase())),
    GOOGLE_WEB_CLIENT_ID: optionalString,
    JWT_SECRET: optionalString,
    BINANCE_API_KEY: optionalString,
    BINANCE_API_SECRET: optionalString,
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_CHANNEL_ID: optionalString,
    /** Telegram posts only when this is true AND both TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID are set. */
    TELEGRAM_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")).transform((v) => v === "true"),
    /** Admin toggle: also post the events of demo trades (TP1, TP2, TP3, stop) to the channel. Off by default. */
    TELEGRAM_POST_DEMO: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),
    /** Public invite link the app shows as "Join our channel". Empty = no link. */
    TELEGRAM_CHANNEL_LINK: z.preprocess(emptyToUndefined, z.string().regex(/^https:\/\/\S+$/, "must be an https:// link").optional()),
    /** IANA time zone for the timestamp in Telegram messages. */
    TELEGRAM_TIMEZONE: z.preprocess(emptyToUndefined, z.string().default("Asia/Riyadh")).refine(validZone, "must be a valid IANA time zone, e.g. Asia/Riyadh"),
    /** Which market data provider to use. auto = the first one that answers, and switch if it gets blocked. */
    MARKET_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["auto", "binance", "bybit", "okx", "kraken"]).default("auto")),
    /** poll = fetch the newest candles every 5 seconds (works everywhere). websocket = Binance stream (only with the Binance provider). */
    MARKET_STREAM: z.preprocess(emptyToUndefined, z.enum(["poll", "websocket"]).default("poll")),
    /** Optional override of the Binance REST address (a mirror). Empty = the provider's built-in address. */
    MARKET_DATA_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    /** Optional override of the Binance WebSocket address (only used when MARKET_STREAM=websocket). */
    MARKET_DATA_WS_URL: z.preprocess(emptyToUndefined, z.string().regex(/^wss?:\/\//).optional()),
    MARKET_WS_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")).transform((v) => v === "true"),
    /** Test-user login. Honoured only when NODE_ENV=development. Never enable in production. */
    ENABLE_DEV_LOGIN: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),
    /** Offline demo: serve sample data written by `npm run seed` and never contact the market data provider. */
    DEMO_MODE: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),
    /** File that PUT /api/settings/secrets writes to (default: .env in the working directory). */
    ENV_FILE: optionalString,
    /** Where documents are kept. file = the DATA_DIR folder (development). supabase = Supabase table kv_store (Render). */
    STORAGE: z.preprocess(emptyToUndefined, z.enum(["file", "supabase"]).default("file")),
    SUPABASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    SUPABASE_SERVICE_KEY: optionalString,
    DATA_DIR: z.preprocess(emptyToUndefined, z.string().default("data")),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.JWT_SECRET) {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "JWT_SECRET is required in production" });
    }
    if (env.STORAGE === "supabase") {
      for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"] as const) {
        if (!env[name]) ctx.addIssue({ code: "custom", path: [name], message: `${name} is required when STORAGE=supabase` });
      }
    }
    if (env.JWT_SECRET && env.JWT_SECRET.length < 16) {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "JWT_SECRET must be at least 16 characters" });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n - ${issues.join("\n - ")}`);
    this.name = "EnvError";
  }
}

/** Validates the given variables (defaults to process.env). Throws EnvError listing every problem. */
export interface ParseEnvOptions {
  /** Offline tools (backtest, market check) never sign anyone in, so they skip the Google client ID check. */
  skipAuthCheck?: boolean;
}

/**
 * Validates the given variables (defaults to process.env). Throws EnvError listing every problem.
 * Google sign-in is the real login, so GOOGLE_WEB_CLIENT_ID must be set, except in tests and in development
 * with the test login (ENABLE_DEV_LOGIN=true) switched on.
 */
export function parseEnv(source: Record<string, string | undefined> = process.env, options: ParseEnvOptions = {}): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const env = result.data;
  const devLogin = env.NODE_ENV === "development" && env.ENABLE_DEV_LOGIN;
  if (!options.skipAuthCheck && env.NODE_ENV !== "test" && !devLogin && !env.GOOGLE_WEB_CLIENT_ID) {
    throw new EnvError([
      "GOOGLE_WEB_CLIENT_ID: is required for Google sign-in. Set it in server/.env to your Web OAuth client ID (ends with .apps.googleusercontent.com).",
    ]);
  }
  return env;
}

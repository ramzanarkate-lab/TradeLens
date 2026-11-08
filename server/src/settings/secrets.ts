import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { parseEnv, type Env } from "../config/env.js";

export const SECRET_KEYS = ["BINANCE_API_KEY", "BINANCE_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
/** Plain (non-secret) values the same endpoint can write. They are not reported by status(); GET /api/telegram/status reports them. */
export const TELEGRAM_SETTING_KEYS = ["TELEGRAM_ENABLED", "TELEGRAM_POST_DEMO", "TELEGRAM_CHANNEL_LINK", "MARKET_PROVIDER"] as const;
const WRITABLE_KEYS = [...SECRET_KEYS, ...TELEGRAM_SETTING_KEYS] as const;

/** Empty string clears the secret. Otherwise length and characters are checked per key. */
const optionalValue = (rule: z.ZodString) => z.union([z.literal(""), rule]);

export const secretsBodySchema = z
  .object({
    BINANCE_API_KEY: optionalValue(z.string().regex(/^[A-Za-z0-9]{16,128}$/, "must be 16-128 letters and digits")),
    BINANCE_API_SECRET: optionalValue(z.string().regex(/^[A-Za-z0-9]{16,128}$/, "must be 16-128 letters and digits")),
    TELEGRAM_BOT_TOKEN: optionalValue(z.string().regex(/^\d{6,12}:[A-Za-z0-9_-]{30,50}$/, "must look like 123456789:AA... (bot id, colon, 30-50 token characters)")),
    TELEGRAM_CHANNEL_ID: optionalValue(z.string().regex(/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{5,20})$/, "must be @channelname or a numeric chat id")),
    TELEGRAM_ENABLED: z.enum(["true", "false"]),
    TELEGRAM_POST_DEMO: z.enum(["true", "false"]),
    MARKET_PROVIDER: z.enum(["auto", "binance", "bybit", "okx", "kraken"]),
    TELEGRAM_CHANNEL_LINK: optionalValue(z.string().regex(/^https:\/\/[A-Za-z0-9./_+~=-]{3,100}$/, "must be an https:// link")),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, "send at least one secret");

export type SecretsBody = z.infer<typeof secretsBodySchema>;

/**
 * Secret values live only in the .env file and the process environment. They are never returned,
 * logged, or kept anywhere else: the API reports only whether each one is set.
 */
export class SecretsService {
  private current: Env;

  constructor(
    private readonly envFile: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.current = parseEnv(env, { skipAuthCheck: true });
  }

  status(): Record<SecretKey, boolean> {
    return Object.fromEntries(SECRET_KEYS.map((key) => [key, Boolean(this.env[key])])) as Record<SecretKey, boolean>;
  }

  /** The reloaded environment (for server code that needs the actual values, e.g. the Telegram sender; it follows every change to secrets). */
  get reloadedEnv(): Env {
    return this.current;
  }

  /** Writes the given keys into the env file (keeping every other line), updates the process environment and re-parses it. */
  async set(values: SecretsBody): Promise<void> {
    const lines = existsSync(this.envFile) ? readFileSync(this.envFile, "utf8").split(/\r?\n/) : [];
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    for (const key of WRITABLE_KEYS) {
      const value = values[key];
      if (value === undefined) continue;
      const line = `${key}=${value}`; // characters are restricted by the schema: no quotes, spaces or newlines possible
      const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
      if (at >= 0) lines[at] = line;
      else lines.push(line);
    }

    const tmp = `${this.envFile}.tmp`;
    await writeFile(tmp, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.envFile);

    for (const key of WRITABLE_KEYS) {
      const value = values[key];
      if (value === undefined) continue;
      if (value === "") delete this.env[key];
      else this.env[key] = value;
    }
    this.current = parseEnv(this.env, { skipAuthCheck: true });
  }
}

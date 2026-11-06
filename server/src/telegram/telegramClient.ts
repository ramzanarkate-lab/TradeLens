export interface TelegramCredentials {
  token: string;
  chatId: string;
}

export type SendResult = { ok: true; messageId: number } | { ok: false; reason: string };

export interface TelegramClientOptions {
  /** Read on every send, so a changed token or channel applies without a restart. Undefined = not configured. */
  credentials: () => TelegramCredentials | undefined;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Wait before retry 1, 2 and 3. */
  backoffMs?: readonly number[];
  /** Longest wait honoured for a 429 retry_after. */
  maxRetryAfterMs?: number;
}

const DEFAULT_BACKOFF = [2_000, 5_000, 15_000] as const;

/** Removes the bot token (and anything shaped like one) from text before it is logged or returned. */
export function redactToken(text: string, token?: string): string {
  let out = text.replace(/\/bot[^/\s"']+/g, "/bot<redacted>").replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,50}\b/g, "<redacted>");
  if (token) out = out.split(token).join("<redacted>");
  return out;
}

export class TelegramClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly backoff: readonly number[];
  private readonly maxRetryAfterMs: number;

  constructor(private readonly opts: TelegramClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000;
  }

  isConfigured(): boolean {
    return this.opts.credentials() !== undefined;
  }

  /** sendMessage with HTML parse mode. Retries network errors, HTTP 429 (waits retry_after) and 5xx up to 3 times. */
  async sendMessage(text: string): Promise<SendResult> {
    const creds = this.opts.credentials();
    if (!creds) return { ok: false, reason: "Telegram is not configured" };
    let reason = "unknown error";

    for (let attempt = 0; attempt <= this.backoff.length; attempt++) {
      let wait = this.backoff[attempt] ?? 0;
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: creds.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          description?: string;
          result?: { message_id?: number };
          parameters?: { retry_after?: number };
        } | null;

        if (res.ok && body?.ok && typeof body.result?.message_id === "number") {
          return { ok: true, messageId: body.result.message_id };
        }
        reason = redactToken(`Telegram HTTP ${res.status}${body?.description ? `: ${body.description}` : ""}`, creds.token);
        if (res.status === 429) {
          const seconds = body?.parameters?.retry_after;
          if (typeof seconds === "number") wait = Math.min(seconds * 1000, this.maxRetryAfterMs);
        } else if (res.status < 500) {
          return { ok: false, reason }; // 400/401/403/404: retrying cannot help
        }
      } catch (err) {
        reason = redactToken(`Network error: ${err instanceof Error ? err.message : String(err)}`, creds.token);
      }
      if (attempt === this.backoff.length) break;
      await this.sleep(wait);
    }
    return { ok: false, reason };
  }
}

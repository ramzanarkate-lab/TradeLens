import { assertSafeKey, KeyedQueue, type Store } from "./store.js";

export interface SupabaseStoreOptions {
  /** https://<project>.supabase.co */
  url: string;
  /** The service key. It stays on the server; it is sent only in the apikey and Authorization headers. */
  serviceKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Documents in the Supabase table kv_store (see supabase/schema.sql), through its REST API. */
export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private readonly queue = new KeyedQueue();
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly o: SupabaseStoreOptions) {
    this.base = `${o.url.replace(/\/+$/, "")}/rest/v1/kv_store`;
    this.fetchFn = o.fetchFn ?? fetch;
  }

  private async call(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await this.fetchFn(url, {
      method: init.method,
      body: init.body,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      headers: { apikey: this.o.serviceKey, Authorization: `Bearer ${this.o.serviceKey}`, "content-type": "application/json", ...init.headers },
    });
    // The message never includes the URL, the key or the response body, so nothing secret can reach a log.
    if (!res.ok) throw new Error(`Supabase request failed with HTTP ${res.status}`);
    return res;
  }

  async get(key: string): Promise<unknown | undefined> {
    assertSafeKey(key);
    const res = await this.call(`${this.base}?key=eq.${encodeURIComponent(key)}&select=value`);
    const rows = (await res.json()) as Array<{ value: unknown }>;
    return rows.length ? rows[0]!.value : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    assertSafeKey(key);
    return await this.queue.run(key, async () => {
      await this.call(`${this.base}?on_conflict=key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value, updated_at: new Date((this.o.now ?? Date.now)()).toISOString() }),
      });
    });
  }

  async list(prefix = ""): Promise<string[]> {
    const filter = prefix ? `&key=like.${encodeURIComponent(`${prefix}*`)}` : "";
    const res = await this.call(`${this.base}?select=key&order=key.asc${filter}`);
    return ((await res.json()) as Array<{ key: string }>).map((r) => r.key);
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.js";

/** Only what is needed to show and score a headline. Article text is never stored or shown (copyright). */
export interface NewsItem {
  headline: string;
  source: string;
  link: string;
  /** Epoch ms. */
  publishedAt: number;
}

export interface FeedConfig {
  name: string;
  url: string;
}

export interface FeedStatus {
  name: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  ok: boolean;
  error: string | null;
}

export const MAX_STORED_ITEMS = 500;
export const POLL_EVERY_MS = 5 * 60_000;
export const FEED_TIMEOUT_MS = 8_000;

export const DEFAULT_FEEDS: FeedConfig[] = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
];

/** The feed list from server/config/news-sources.json (built-in defaults if the file is missing or broken). */
export function loadFeeds(file: URL | string): FeedConfig[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { feeds?: FeedConfig[] };
    const feeds = (raw.feeds ?? []).filter((f) => typeof f?.name === "string" && /^https?:\/\//.test(f?.url ?? ""));
    return feeds.length ? feeds : DEFAULT_FEEDS;
  } catch {
    return DEFAULT_FEEDS;
  }
}

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "") // a title never needs markup
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

const tag = (block: string, name: string): string | undefined => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : undefined;
};

/** Reads RSS (<item>) or Atom (<entry>). Only the title, link and publish time are kept: the body text is dropped here. */
export function parseFeed(xml: string, source: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const block = m[2]!;
    const headline = tag(block, "title");
    const link = tag(block, "link") ?? block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const date = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date");
    const publishedAt = date ? Date.parse(date) : NaN;
    if (!headline || !link || Number.isNaN(publishedAt)) continue;
    out.push({ headline, source, link, publishedAt });
  }
  return out;
}

export interface NewsFetcherOptions {
  feeds: FeedConfig[];
  file: string;
  logger: Logger;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Called once after each polling round with the items that were new. */
  onNew?: (items: NewsItem[]) => void;
}

/** Polls every feed every 5 minutes (8 second timeout each) and keeps the newest 500 headlines in news.json. */
export class NewsFetcher {
  private items: NewsItem[];
  private readonly statuses = new Map<string, FeedStatus>();
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  readonly startedAt: number;

  constructor(private readonly o: NewsFetcherOptions) {
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetchFn ?? fetch;
    this.startedAt = this.now();
    this.items = this.load();
    for (const f of o.feeds) this.statuses.set(f.name, { name: f.name, lastAttemptAt: null, lastSuccessAt: null, ok: false, error: null });
  }

  start(): void {
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), POLL_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Newest first. */
  all(): NewsItem[] {
    return [...this.items].sort((a, b) => b.publishedAt - a.publishedAt);
  }

  feedStatus(): FeedStatus[] {
    return [...this.statuses.values()];
  }

  /** The last time any feed answered, or null if none has since the server started. */
  lastSuccessAt(): number | null {
    const times = [...this.statuses.values()].map((s) => s.lastSuccessAt).filter((t): t is number => t !== null);
    return times.length ? Math.max(...times) : null;
  }

  async pollOnce(): Promise<void> {
    const fresh: NewsItem[] = [];
    await Promise.all(this.o.feeds.map((feed) => this.pollFeed(feed, fresh)));
    if (fresh.length > 0) {
      const known = new Set(this.items.map((i) => i.link));
      const added = fresh.filter((i) => !known.has(i.link));
      this.items = [...this.items, ...added].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_STORED_ITEMS);
      this.save();
      if (added.length) this.o.onNew?.(added);
    }
  }

  private async pollFeed(feed: FeedConfig, into: NewsItem[]): Promise<void> {
    const status = this.statuses.get(feed.name)!;
    status.lastAttemptAt = this.now();
    try {
      const res = await this.fetchFn(feed.url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS), headers: { "user-agent": "TradeLens/1.0 (news headlines)", accept: "application/rss+xml, application/xml, text/xml" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(await res.text(), feed.name);
      into.push(...items);
      status.ok = true;
      status.error = null;
      status.lastSuccessAt = this.now();
    } catch (err) {
      status.ok = false;
      status.error = err instanceof Error ? err.message : String(err);
      this.o.logger.warn({ feed: feed.name, err: status.error }, "news feed failed");
    }
  }

  private load(): NewsItem[] {
    try {
      if (!existsSync(this.o.file)) return [];
      const raw = JSON.parse(readFileSync(this.o.file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      // keep only the four known fields, whatever the file contains
      return raw
        .filter((i) => i && typeof i.headline === "string" && typeof i.link === "string" && typeof i.publishedAt === "number")
        .map((i) => ({ headline: i.headline, source: String(i.source ?? ""), link: i.link, publishedAt: i.publishedAt }));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      writeFileSync(`${this.o.file}.tmp`, JSON.stringify(this.items));
      renameSync(`${this.o.file}.tmp`, this.o.file);
    } catch (err) {
      this.o.logger.error({ err: err instanceof Error ? err.message : String(err) }, "could not save news.json");
    }
  }
}

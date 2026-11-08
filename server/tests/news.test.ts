import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { matchSymbols, weightFor } from "../src/news/match.js";
import { NewsService, STALE_AFTER_MS } from "../src/news/service.js";
import { loadKeywords, RuleBasedScorer } from "../src/news/sentiment.js";
import { NewsFetcher, parseFeed, type NewsItem } from "../src/news/sources.js";
import { DEFAULT_ENGINE_CONFIG, evaluateAt, prepareContext } from "../src/signals/engine.v2.js";
import { evaluateNews, type NewsSettings, type ScoredHeadline } from "../src/signals/newsFilter.js";
import { DAY_MS, H4_MS, HOUR_MS } from "../src/signals/mtf.js";
import { DEFAULT_SETTINGS, sectionSchemas } from "../src/settings/schema.js";
import type { Candle } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
const scorer = new RuleBasedScorer(loadKeywords(new URL("../config/news-keywords.json", import.meta.url)));
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const MIN = 60_000;
const settings: NewsSettings = { enabled: true, windowMinutes: 60, boostPoints: 5, vetoEnabled: true };
const head = (headline: string, minutesAgo: number, score: number): ScoredHeadline => ({ headline, source: "T", publishedAt: NOW - minutesAgo * MIN, score });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-news-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("symbol matching", () => {
  it("matches whole words only", () => {
    expect(matchSymbols("A solution for everyone").symbols).toEqual([]);
    expect(matchSymbols("Sol hits a new high").symbols).toEqual(["SOLUSDT"]);
    expect(matchSymbols("Solana and SOL rally").symbols).toEqual(["SOLUSDT"]);
    expect(matchSymbols("The method of the ether").symbols).toEqual(["ETHUSDT"]);
    expect(matchSymbols("Bitcoin (BTC) falls").symbols).toEqual(["BTCUSDT"]);
    expect(matchSymbols("Nothing about coins").symbols).toEqual([]);
  });

  it("a headline naming all three is market-wide at half weight; one naming a single coin is full weight", () => {
    const all = matchSymbols("Bitcoin, Ethereum and Solana all fall");
    expect(all.marketWide).toBe(true);
    expect(weightFor("BTCUSDT", all)).toBe(0.5);
    expect(weightFor("SOLUSDT", matchSymbols("Solana surges"))).toBe(1);
    expect(weightFor("BTCUSDT", matchSymbols("Solana surges"))).toBe(0);
  });
});

describe("sentiment", () => {
  it("scores bullish and bearish keywords, clamped to -3..+3", () => {
    expect(scorer.score("Spot ETF approved")).toBe(1);
    expect(scorer.score("Exchange hack and exploit trigger sell-off")).toBe(-3);
    expect(scorer.score("Record high, rally, surge and ETF inflow after approval")).toBe(3); // 5 bullish words, clamped
    expect(scorer.score("Bitcoin holds steady")).toBe(0);
  });

  it("a negated bullish word counts as bearish", () => {
    expect(scorer.score("ETF not approved")).toBe(-1);
    expect(scorer.score("Regulator says no approval this year")).toBe(-1);
    expect(scorer.score("Exchange fails to launch the product")).toBe(-1);
    expect(scorer.score("Not in the last three words: it was widely approved")).toBe(1); // "not" is more than 3 words before "approved"
  });

  it("finds multi-word and hyphenated keywords and ignores look-alike words", () => {
    expect(scorer.score("SEC sues the exchange")).toBe(-1);
    expect(scorer.score("Bitcoin ETF inflow tops $1B")).toBe(1);
    expect(scorer.score("Crypto sell off deepens")).toBe(-1);
    expect(scorer.score("Bank of Japan meets")).toBe(0); // "ban" is not "bank"
  });
});

describe("news decision", () => {
  it("only headlines from the last 60 minutes count", () => {
    const old = [head("Exchange hack", 61, -3), head("Exploit found", 90, -3)];
    expect(evaluateNews("BUY", old, settings, NOW).veto).toBeNull();
    expect(evaluateNews("BUY", [head("Exchange hack", 59, -3)], settings, NOW).veto).toMatch(/blocked this BUY/);
  });

  it("net -3 blocks a BUY, with the headline and age in the reason", () => {
    const r = evaluateNews("BUY", [head("SEC lawsuit hits exchange", 12, -3)], settings, NOW);
    expect(r.veto).toBe("Negative news (SEC lawsuit hits exchange, 12 min ago) blocked this BUY");
    expect(r.logRecord?.decision).toBe("veto");
    expect(r.logRecord?.headlines[0]).toMatchObject({ headline: "SEC lawsuit hits exchange", score: -3 });
  });

  it("net +2 or more boosts a BUY by 5 points; net -2 or less boosts a SELL; +3 blocks a SELL", () => {
    expect(evaluateNews("BUY", [head("ETF inflow", 8, 2)], settings, NOW)).toMatchObject({ points: 5, veto: null, record: { decision: "boost", netScore: 2, points: 5 } });
    expect(evaluateNews("BUY", [head("a", 8, 1)], settings, NOW).points).toBe(0); // +1 is not enough
    expect(evaluateNews("SELL", [head("Exchange hack", 8, -2)], settings, NOW).points).toBe(5);
    expect(evaluateNews("SELL", [head("Spot ETF approved", 5, 3)], settings, NOW).veto).toMatch(/blocked this SELL/);
    expect(evaluateNews("SELL", [head("a", 5, 2)], settings, NOW).veto).toBeNull(); // +2 does not block a SELL
  });

  it("the net score is clamped to -5..+5 and the boost is saved with the headlines", () => {
    const r = evaluateNews("BUY", [head("a", 1, 3), head("b", 2, 3), head("c", 3, 3)], settings, NOW);
    expect(r.record?.netScore).toBe(5);
    expect(r.record?.headlines).toHaveLength(3);
  });

  it("newsVetoEnabled=false keeps the boost but never blocks; newsEnabled=false removes every effect", () => {
    expect(evaluateNews("BUY", [head("hack", 5, -3)], { ...settings, vetoEnabled: false }, NOW).veto).toBeNull();
    const off = evaluateNews("BUY", [head("hack", 5, -3), head("etf", 5, 5)], { ...settings, enabled: false }, NOW);
    expect(off).toMatchObject({ points: 0, veto: null, record: null });
  });
});

describe("engine: news never creates a signal alone", () => {
  function series() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const h1: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 280 * 24; i++) {
      const open = price;
      price = open * (1 + 0.0004 + (rnd() - 0.5) * 0.01);
      h1.push({ time: i * HOUR_MS, open, high: Math.max(open, price) * 1.002, low: Math.min(open, price) * 0.998, close: price, volume: 100 + rnd() * 100, closed: true });
    }
    const regroup = (size: number) => {
      const per = size / HOUR_MS;
      const out: Candle[] = [];
      for (let k = 0; k + per <= h1.length; k += per) {
        const g = h1.slice(k, k + per);
        out.push({ time: g[0]!.time, open: g[0]!.open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[per - 1]!.close, volume: g.reduce((s, x) => s + x.volume, 0), closed: true });
      }
      return out;
    };
    return { h1, h4: regroup(H4_MS), d1: regroup(DAY_MS) };
  }
  const ctx0 = prepareContext("BTCUSDT", series());
  const up = { ...ctx0, ema200d: ctx0.ema200d.map(() => 1e-12) };
  const wide = { ...DEFAULT_ENGINE_CONFIG, minRiskPercent: 0, maxRiskPercent: 100 };
  const boost = { points: 5, veto: null, record: { decision: "boost" as const, netScore: 3, points: 5, headlines: [{ headline: "ETF inflow", source: "T", score: 3, minutesAgo: 8 }] }, reasons: ["Positive news (ETF inflow, 8 min ago) added 5 points"], logRecord: null };
  const veto = { points: 0, veto: "Negative news (SEC lawsuit, 12 min ago) blocked this BUY", record: null, reasons: [], logRecord: null };
  const run = (i: number, minScore: number, news?: () => typeof boost | typeof veto) => evaluateAt(up, i, { config: { ...wide, minScore }, hasOpen: () => false, news });

  const firstAt0 = Array.from({ length: up.series.h1.length }, (_, i) => run(i, 0)).findIndex((o) => o.signal);

  it("great news cannot lift a signal over the threshold: below the score it stays blocked", () => {
    const base = run(firstAt0, 0).signal!;
    const threshold = base.score! + 1; // the signal's own score is one point short
    expect(run(firstAt0, threshold).signal).toBeNull();
    expect(run(firstAt0, threshold, () => boost).signal).toBeNull();
  });

  it("with a signal that already qualifies, a boost adds points and is saved with the signal", () => {
    const base = run(firstAt0, 0).signal!;
    const boosted = run(firstAt0, 0, () => boost).signal!;
    expect(boosted.score).toBe(Math.min(100, base.score! + 5));
    expect(boosted.news).toMatchObject({ decision: "boost", points: 5 });
    expect(boosted.reasons!.some((r) => r.startsWith("Positive news"))).toBe(true);
  });

  it("a veto blocks the signal and says why", () => {
    const out = run(firstAt0, 0, () => veto);
    expect(out).toMatchObject({ signal: null, reason: expect.stringContaining("blocked this BUY") });
  });
});

describe("feeds, outage and storage", () => {
  const rss = (items: Array<{ title: string; link: string; date: string; body?: string }>) =>
    `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><pubDate>${i.date}</pubDate><description><![CDATA[${i.body ?? ""}]]></description><content:encoded>${i.body ?? ""}</content:encoded></item>`).join("")}</channel></rss>`;
  const okFetch = (xml: string) => vi.fn(async () => new Response(xml, { status: 200 })) as unknown as typeof fetch;

  it("stored headlines hold only the headline, source, link and time, never article text", async () => {
    const SECRET_BODY = "FULL ARTICLE BODY TEXT THAT MUST NOT BE STORED";
    const file = join(dir, "news.json");
    const fetcher = new NewsFetcher({
      feeds: [{ name: "Feed", url: "https://feed.test/rss" }],
      file,
      logger: silent,
      now: () => NOW,
      fetchFn: okFetch(rss([{ title: "Bitcoin ETF approved", link: "https://x.test/1", date: new Date(NOW - 5 * MIN).toUTCString(), body: SECRET_BODY }])),
    });
    await fetcher.pollOnce();
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(SECRET_BODY);
    const [item] = JSON.parse(text) as NewsItem[];
    expect(Object.keys(item!).sort()).toEqual(["headline", "link", "publishedAt", "source"]);
    expect(item).toMatchObject({ headline: "Bitcoin ETF approved", source: "Feed", link: "https://x.test/1" });
  });

  it("keeps the newest 500 and does not store the same link twice", async () => {
    const items = Array.from({ length: 520 }, (_, i) => ({ title: `Bitcoin item ${i}`, link: `https://x.test/${i}`, date: new Date(NOW - i * MIN).toUTCString() }));
    const fetcher = new NewsFetcher({ feeds: [{ name: "F", url: "https://feed.test/rss" }], file: join(dir, "news.json"), logger: silent, now: () => NOW, fetchFn: okFetch(rss(items)) });
    await fetcher.pollOnce();
    await fetcher.pollOnce();
    expect(fetcher.all()).toHaveLength(500);
    expect(fetcher.all()[0]!.headline).toBe("Bitcoin item 0");
  });

  it("parses Atom feeds and skips entries without a title, link or date", () => {
    const atom = `<feed><entry><title>Solana upgrade ships</title><link href="https://a.test/1"/><updated>2026-11-06T11:00:00Z</updated></entry><entry><title>No date</title><link href="https://a.test/2"/></entry></feed>`;
    expect(parseFeed(atom, "A")).toEqual([{ headline: "Solana upgrade ships", source: "A", link: "https://a.test/1", publishedAt: Date.parse("2026-11-06T11:00:00Z") }]);
  });

  it("a 30-minute outage switches the filter off for the symbol, logs it once, and /health shows stale", async () => {
    let t = NOW;
    let up = true;
    const fetchFn = vi.fn(async () => {
      if (!up) throw new Error("network down");
      return new Response(rss([{ title: "Bitcoin exchange hack, exploit and lawsuit", link: "https://x.test/h", date: new Date(NOW).toUTCString() }]), { status: 200 });
    }) as unknown as typeof fetch;
    const warn = vi.fn();
    const logger = { ...silent, warn, info: vi.fn(), error: vi.fn() } as never;
    const fetcher = new NewsFetcher({ feeds: [{ name: "F", url: "https://feed.test/rss" }], file: join(dir, "news.json"), logger, now: () => t, fetchFn });
    const service = new NewsService({ fetcher, scorer, logger, now: () => t });

    await fetcher.pollOnce();
    expect(service.feedHealth()).toBe("ok");
    t += 10 * MIN;
    expect(service.evaluate("BTCUSDT", "BUY", { ...settings, windowMinutes: 120 }).veto).toMatch(/blocked this BUY/); // news is active

    up = false;
    await fetcher.pollOnce();
    t += STALE_AFTER_MS; // 40 minutes since the last good fetch
    expect(service.feedHealth()).toBe("stale");
    expect(service.evaluate("BTCUSDT", "BUY", { ...settings, windowMinutes: 120 })).toMatchObject({ points: 0, veto: null });
    service.evaluate("BTCUSDT", "BUY", settings);
    expect(warn.mock.calls.filter((c) => /news filter is OFF/.test(String(c[1])))).toHaveLength(1); // logged once

    const app = createApp({ env: { CORS_ORIGINS: [] }, logger: silent, clientCount: () => 0, healthExtra: () => ({ newsStatus: service.healthStatus(true) }) });
    expect((await request(app).get("/health").expect(200)).body.newsStatus).toBe("stale");

    up = true; // the network returns: the filter comes back
    await fetcher.pollOnce();
    expect(service.feedHealth()).toBe("ok");
  });

  it("newsEnabled=false removes every news effect and is reported as off", () => {
    const fetcher = { all: () => [] as NewsItem[], feedStatus: () => [], lastSuccessAt: () => NOW, startedAt: NOW };
    const service = new NewsService({ fetcher, scorer, logger: silent, now: () => NOW });
    expect(service.evaluate("BTCUSDT", "BUY", { ...settings, enabled: false })).toMatchObject({ points: 0, veto: null, record: null });
    expect(service.healthStatus(false)).toBe("off");
  });
});

describe("news settings and endpoints", () => {
  it("defaults and validation", () => {
    expect(DEFAULT_SETTINGS.signals).toMatchObject({ newsEnabled: true, newsWindowMinutes: 60, newsBoostPoints: 5, newsVetoEnabled: true });
    const ok = (patch: object) => sectionSchemas.signals.safeParse({ ...DEFAULT_SETTINGS.signals, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ newsWindowMinutes: 4 })).toBe(false);
    expect(ok({ newsWindowMinutes: 1441 })).toBe(false);
    expect(ok({ newsBoostPoints: 21 })).toBe(false);
    expect(ok({ newsBoostPoints: 2.5 })).toBe(false);
    expect(ok({ newsEnabled: "yes" })).toBe(false);
  });

  it("GET /api/news: guests get 5, signed-in users up to 50, scores included; /api/news/status is admin only", async () => {
    const items: NewsItem[] = Array.from({ length: 60 }, (_, i) => ({ headline: `Bitcoin ETF approved ${i}`, source: "T", link: `https://x.test/${i}`, publishedAt: NOW - i * MIN }));
    const fetcher = { all: () => items, feedStatus: () => [{ name: "F", lastAttemptAt: NOW, lastSuccessAt: NOW, ok: true, error: null }], lastSuccessAt: () => NOW, startedAt: NOW };
    const service = new NewsService({ fetcher, scorer, logger: silent, now: () => NOW });
    const auth = new AuthService({ secret: "a-long-enough-test-secret", adminIds: () => ["admin"] });
    const bearer = (id: string) => ({ Authorization: `Bearer ${auth.issue({ id, email: `${id}@x.test`, name: id, emailVerified: true }).token}` });
    const app = createApp({
      env: { CORS_ORIGINS: [] },
      logger: silent,
      clientCount: () => 0,
      auth,
      rateLimit: { limit: 1000 },
      news: { service, feeds: () => fetcher.feedStatus(), settings: () => ({ enabled: true, windowMinutes: 60 }) },
    });
    const guest = await request(app).get("/api/news?symbol=BTCUSDT").expect(200);
    expect(guest.body.news).toHaveLength(5);
    expect(guest.body.news[0]).toMatchObject({ headline: "Bitcoin ETF approved 0", score: 1, symbols: ["BTCUSDT"] });
    expect(Object.keys(guest.body.news[0]).sort()).toEqual(["headline", "link", "publishedAt", "score", "source", "symbols"]);
    const user = await request(app).get("/api/news?symbol=BTCUSDT").set(bearer("u")).expect(200);
    expect(user.body.news).toHaveLength(50);
    expect((await request(app).get("/api/news?symbol=SOLUSDT").set(bearer("u")).expect(200)).body.news).toHaveLength(0);

    await request(app).get("/api/news/status").expect(401);
    await request(app).get("/api/news/status").set(bearer("u")).expect(403);
    const status = await request(app).get("/api/news/status").set(bearer("admin")).expect(200);
    expect(status.body).toMatchObject({ status: "ok", enabled: true, windowMinutes: 60 });
    expect(status.body.feeds[0]).toMatchObject({ name: "F", ok: true });
  });
});

/**
 * Fetches the news feeds once and prints the matched headlines per symbol (headline and score only).
 *   npm run news:fetch
 * Nothing is written to data/news.json.
 */
import { SYMBOLS } from "../src/config/symbols.js";
import { createLogger } from "../src/logging/logger.js";
import { NewsService } from "../src/news/service.js";
import { loadKeywords, RuleBasedScorer } from "../src/news/sentiment.js";
import { loadFeeds, NewsFetcher } from "../src/news/sources.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logger = createLogger({ level: "warn", pretty: false });
const fetcher = new NewsFetcher({
  feeds: loadFeeds(new URL("../config/news-sources.json", import.meta.url)),
  file: join(tmpdir(), `tradelens-news-${process.pid}.json`),
  logger,
});
await fetcher.pollOnce();
const service = new NewsService({ fetcher, scorer: new RuleBasedScorer(loadKeywords(new URL("../config/news-keywords.json", import.meta.url))), logger });

console.log("FEEDS");
for (const f of fetcher.feedStatus()) console.log(`  ${f.name.padEnd(14)} ${f.ok ? "ok" : `FAILED (${f.error})`}`);
console.log(`\nStatus: ${service.feedHealth()}   Headlines fetched: ${fetcher.all().length}`);
for (const symbol of SYMBOLS) {
  const items = service.recent(symbol, 50);
  console.log(`\n${symbol}: ${items.length} matched headline(s)`);
  for (const i of items.slice(0, 15)) console.log(`  ${String(i.score >= 0 ? `+${i.score}` : i.score).padStart(3)}  ${i.headline}${i.marketWide ? "  [market-wide, half weight]" : ""}`);
}

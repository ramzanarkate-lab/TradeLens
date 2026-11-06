/**
 * Replays the multi-indicator engine over historical candles, candle by candle, with fees and slippage.
 *   npm run backtest -- --symbol BTCUSDT --months 24 [--provider okx]
 * History is cached in server/data/history/. The report goes to server/data/backtests/<symbol>-<date>.json.
 * The first 70% of the period is in-sample, the last 30% out-of-sample. Engine rules are never tuned on the out-of-sample part.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COSTS, judge, metrics, REPORT_NOTE, replay, splitTrades, type BacktestReport } from "../src/backtest/backtest.js";
import { loadHistory } from "../src/backtest/history.js";
import { parseEnv } from "../src/config/env.js";
import { DEFAULT_SETTINGS } from "../src/settings/schema.js";
import { isSymbol } from "../src/config/symbols.js";
import { BinanceProvider } from "../src/market/providers/binance.js";
import { BybitProvider } from "../src/market/providers/bybit.js";
import { OkxProvider } from "../src/market/providers/okx.js";
import type { MarketProvider } from "../src/market/providers/types.js";
import { DAY_MS, HOUR_MS } from "../src/signals/mtf.js";
import { readFileSync, existsSync } from "node:fs";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const symbol = (arg("symbol", "BTCUSDT") ?? "").toUpperCase();
const months = Number(arg("months", "12"));
if (!isSymbol(symbol)) throw new Error(`Unknown symbol ${symbol}. Use BTCUSDT, SOLUSDT or ETHUSDT.`);
if (!Number.isFinite(months) || months < 1 || months > 60) throw new Error("--months must be between 1 and 60");

const env = parseEnv(process.env, { skipAuthCheck: true });
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(serverRoot, env.DATA_DIR);

// Strategy settings and PASS thresholds come from the saved settings (defaults if none are saved).
const saved = (() => {
  const file = resolve(dataDir, "settings.json");
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { signals?: Partial<typeof DEFAULT_SETTINGS.signals> }).signals ?? {} : {};
  } catch {
    return {};
  }
})();
const s = { ...DEFAULT_SETTINGS.signals, ...saved };

// Pick a provider that can page through history (Kraken keeps only the newest 720 candles).
const candidates: MarketProvider[] = [new BybitProvider(), new OkxProvider(), new BinanceProvider({ baseUrl: env.MARKET_DATA_BASE_URL })];
const wanted = arg("provider", env.MARKET_PROVIDER === "kraken" ? "auto" : env.MARKET_PROVIDER);
let provider: MarketProvider | undefined;
for (const p of wanted && wanted !== "auto" ? candidates.filter((c) => c.name === wanted) : candidates) {
  const ping = await p.ping();
  if (ping.ok) {
    provider = p;
    break;
  }
  console.log(`${p.name}: not reachable (${ping.detail}), trying the next provider`);
}
if (!provider) throw new Error("No provider that supports history is reachable. Run npm run check:market.");
console.log(`Provider: ${provider.name}   Symbol: ${symbol}   Months: ${months}`);

const now = Date.now();
const startTime = Math.floor((now - months * 30.4375 * DAY_MS) / HOUR_MS) * HOUR_MS;
const cacheDir = resolve(dataDir, "history");
const log = (m: string) => console.log(m);
const common = { provider, symbol, endMs: now, cacheDir, log } as const;
const h1 = await loadHistory({ ...common, interval: "1h", startMs: startTime - 10 * DAY_MS });
const h4 = await loadHistory({ ...common, interval: "4h", startMs: startTime - 40 * DAY_MS });
const d1 = await loadHistory({ ...common, interval: "1d", startMs: startTime - 300 * DAY_MS });
console.log(`Candles: ${h1.length} x 1H, ${h4.length} x 4H, ${d1.length} x 1D`);
if (d1.length < 210) throw new Error("Not enough daily history for the 1D EMA200 (need 210 candles).");

const baseConfig = { minScore: s.minScore, minRiskPercent: s.minRiskPercent, maxRiskPercent: s.maxRiskPercent, mode: "paper" as const };
const reversalOn = { enabled: true, minVolumeRatio: s.reversalMinVolumeRatio, levelToleranceAtr: s.reversalLevelToleranceAtr, patterns: s.reversalPatterns };

const lastTime = h1[h1.length - 1]!.time + HOUR_MS;
const splitAt = Math.floor((startTime + (lastTime - startTime) * 0.7) / HOUR_MS) * HOUR_MS;
const spanMonths = (lastTime - startTime) / (30.4375 * DAY_MS);

/** The same candles, the same rules; only the reversal-candle rule differs. */
function run(reversal: boolean) {
  const config = { ...baseConfig, ...(reversal ? { reversal: reversalOn } : {}) };
  const { trades, openAtEnd } = replay({ symbol, series: { h1, h4, d1 }, startTime, config, timeStopHours: s.timeStopHours, costs: DEFAULT_COSTS });
  const { inSample, outOfSample } = splitTrades(trades, splitAt);
  return { config, trades, openAtEnd, inM: metrics(inSample, spanMonths * 0.7), outM: metrics(outOfSample, spanMonths * 0.3) };
}
const off = run(false);
const on = run(true);
// The saved report (and so the live-mode gate) is for the rules the server actually runs: the reversalEnabled setting.
const chosen = s.reversalEnabled ? on : off;
const { config, trades, openAtEnd, inM, outM } = chosen;
const thresholds = { minProfitFactor: s.backtestMinProfitFactor, minTrades: s.backtestMinTrades, maxDrawdownR: s.backtestMaxDrawdownR };
const verdict = judge(outM, thresholds);

const iso = (t: number) => new Date(t).toISOString();
const report: BacktestReport = {
  symbol,
  generatedAt: iso(now),
  provider: provider.name,
  months,
  range: { from: iso(startTime), to: iso(lastTime), splitAt: iso(splitAt) },
  costs: DEFAULT_COSTS,
  engine: { ...config, timeStopHours: s.timeStopHours },
  inSample: inM,
  outOfSample: outM,
  thresholds,
  checks: verdict.checks,
  verdict: verdict.verdict,
  openAtEnd,
  note: REPORT_NOTE,
  trades: trades.map((t) => ({
    createdAt: iso(t.signal.createdAt),
    side: t.signal.side,
    score: t.signal.score,
    entry: t.signal.entry!,
    sl: t.signal.sl!,
    exitStatus: t.exitStatus ?? "",
    exitPrice: t.exitPrice,
    grossR: t.grossR,
    netR: t.netR,
    part: t.signal.createdAt < splitAt ? "in-sample" : "out-of-sample",
  })),
};
const outDir = resolve(dataDir, "backtests");
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `${symbol}-${iso(now).slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));

const row = (label: string, v: unknown) => console.log(`  ${label.padEnd(22)} ${v ?? "n/a"}`);
for (const [name, m] of [["IN-SAMPLE (first 70%)", inM], ["OUT-OF-SAMPLE (last 30%)", outM]] as const) {
  console.log(`\n${name}`);
  row("trades", m.trades);
  row("win rate (TP1+) %", m.winRate);
  row("profitable trades %", m.profitableRate);
  row("average R (net)", m.avgR);
  row("profit factor (net)", m.profitFactor ?? (m.trades ? "no losses" : null));
  row("max drawdown (R)", m.maxDrawdownR);
  row("trades per month", m.tradesPerMonth);
  row("longest losing streak", m.longestLosingStreak);
}
console.log("\nREVERSAL CANDLES OFF vs ON (same candles, same costs; net R)");
const cmp = (label: string, a: unknown, b: unknown) => console.log(`  ${label.padEnd(24)} ${String(a ?? "n/a").padStart(10)} ${String(b ?? "n/a").padStart(10)}`);
for (const [name, a, b] of [["IN-SAMPLE", off.inM, on.inM], ["OUT-OF-SAMPLE", off.outM, on.outM]] as const) {
  console.log(`\n  ${name.padEnd(24)} ${"off".padStart(10)} ${"on".padStart(10)}`);
  cmp("trades", a.trades, b.trades);
  cmp("win rate (TP1+) %", a.winRate, b.winRate);
  cmp("profitable trades %", a.profitableRate, b.profitableRate);
  cmp("average R", a.avgR, b.avgR);
  cmp("profit factor", a.profitFactor, b.profitFactor);
  cmp("max drawdown (R)", a.maxDrawdownR, b.maxDrawdownR);
  cmp("longest losing streak", a.longestLosingStreak, b.longestLosingStreak);
}
const pfOff = off.outM.profitFactor ?? 0;
const pfOn = on.outM.profitFactor ?? 0;
const adds = pfOn - pfOff >= 0.1 && on.outM.trades >= 30;
console.log(`\nReversal adds value: ${adds ? "YES" : "NO"} (out-of-sample profit factor ${pfOff} -> ${pfOn}, trades ${on.outM.trades}; YES needs +0.1 and at least 30 trades)`);
console.log("This comparison changes no rule. The rules were fixed before looking at out-of-sample results and are not tuned on them.");

console.log(`\nPeriod ${iso(startTime).slice(0, 10)} to ${iso(lastTime).slice(0, 10)}, split at ${iso(splitAt).slice(0, 10)}. Fees 0.1% per side, slippage 0.05% per fill. ${openAtEnd} signal(s) still open at the end (not counted).`);
console.log("\nVerdict checks (out-of-sample):");
for (const c of verdict.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: need ${c.need}, got ${c.got}`);
console.log(`\nVERDICT: ${verdict.verdict}`);
console.log(`Note: ${REPORT_NOTE}`);
console.log(`Report: ${file}`);

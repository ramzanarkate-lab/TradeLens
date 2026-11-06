/**
 * Replays recent real candles through the signal engine and prints how many signals it produces.
 *   npx tsx scripts/replay-signals.ts [SYMBOL] [CANDLES] [COOLDOWN_MINUTES]
 */
import "dotenv/config";
import { parseEnv } from "../src/config/env.js";
import { DEFAULT_SIGNAL_SETTINGS } from "../src/config/signalDefaults.js";
import { isSymbol } from "../src/config/symbols.js";
import { createLogger } from "../src/logging/logger.js";
import { ProviderRegistry } from "../src/market/providerRegistry.js";
import { BinanceProvider } from "../src/market/providers/binance.js";
import { BybitProvider } from "../src/market/providers/bybit.js";
import { KrakenProvider } from "../src/market/providers/kraken.js";
import { OkxProvider } from "../src/market/providers/okx.js";
import { TIMEFRAME_MS } from "../src/market/aggregate.js";
import { replaySignals } from "../src/signals/replay.js";

const symbol = (process.argv[2] ?? "BTCUSDT").toUpperCase();
const count = Number(process.argv[3] ?? 500);
if (!isSymbol(symbol)) throw new Error(`Unknown symbol ${symbol}`);

const env = parseEnv(process.env, { skipAuthCheck: true });
const rest = new ProviderRegistry({
  mode: env.MARKET_PROVIDER,
  providers: [new BinanceProvider({ baseUrl: env.MARKET_DATA_BASE_URL }), new BybitProvider(), new OkxProvider(), new KrakenProvider()],
  logger: createLogger({ level: "info", pretty: false }),
});
await rest.init();
const settings = { ...DEFAULT_SIGNAL_SETTINGS };
if (process.argv[4]) settings.cooldownMinutes = Number(process.argv[4]); // optional: cooldown override in minutes
const tfMs = TIMEFRAME_MS[settings.timeframe];

const candles = await rest.fetchKlines(symbol, settings.timeframe, count);
const days = Math.ceil((count * tfMs) / TIMEFRAME_MS["1d"]) + 3; // enough daily history for pivots
const daily = await rest.fetchKlines(symbol, "1d", Math.min(days, 1000));

const signals = replaySignals({ symbol, candles, daily, settings });

const closedCount = candles.filter((c) => c.closed).length;
const spanDays = (closedCount * tfMs) / TIMEFRAME_MS["1d"];
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const count_ = (pred: (s: (typeof signals)[number]) => boolean) => signals.filter(pred).length;

console.log(`Symbol ${symbol}, timeframe ${settings.timeframe}, ${closedCount} closed candles (${iso(candles[0]!.time)} to ${iso(candles.at(-1)!.time)} UTC, ~${spanDays.toFixed(1)} days)`);
console.log(`Settings: EMA ${settings.emaFast}/${settings.emaSlow}, RSI(${settings.rsiPeriod}) buy ${settings.rsiBuyMin}-${settings.rsiBuyMax}, sell above ${settings.rsiSellAbove}, cooldown ${settings.cooldownMinutes} min`);
console.log("");
console.log(`BUY signals : ${count_((s) => s.side === "BUY")}`);
console.log(`SELL signals: ${count_((s) => s.side === "SELL")}`);
console.log(`  by trigger -> ema_cross_down: ${count_((s) => s.trigger === "ema_cross_down")}, rsi_overbought: ${count_((s) => s.trigger === "rsi_overbought")}, r2_reached: ${count_((s) => s.trigger === "r2_reached")}`);
console.log(`Total ${signals.length} => ${(signals.length / spanDays).toFixed(2)} per day, one per ${(closedCount / Math.max(signals.length, 1)).toFixed(1)} candles`);
console.log("");
console.log("time (UTC)        side  price        EMAf       EMAs       RSI    trigger");
for (const s of signals) {
  console.log(
    `${iso(s.createdAt)}  ${s.side.padEnd(4)}  ${s.price.toFixed(2).padStart(10)}  ${s.indicators.emaFast.toFixed(1).padStart(9)}  ${s.indicators.emaSlow.toFixed(1).padStart(9)}  ${s.indicators.rsi.toFixed(1).padStart(5)}  ${s.trigger}`,
  );
}

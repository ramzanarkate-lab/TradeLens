import type { Symbol } from "../../config/symbols.js";
import type { ProviderName } from "./types.js";

/** TradeLens symbol -> the name each provider uses. This is the only place symbol names are mapped. */
export const SYMBOL_MAP: Record<Symbol, Record<ProviderName, string>> = {
  BTCUSDT: { binance: "BTCUSDT", bybit: "BTCUSDT", okx: "BTC-USDT", kraken: "XBTUSDT" },
  SOLUSDT: { binance: "SOLUSDT", bybit: "SOLUSDT", okx: "SOL-USDT", kraken: "SOLUSDT" },
  ETHUSDT: { binance: "ETHUSDT", bybit: "ETHUSDT", okx: "ETH-USDT", kraken: "ETHUSDT" },
};

export function providerSymbol(provider: ProviderName, symbol: Symbol): string {
  return SYMBOL_MAP[symbol][provider];
}

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_SETTINGS } from "../src/config/signalDefaults.js";
import { DashboardService } from "../src/dashboard/service.js";
import { createLogger } from "../src/logging/logger.js";
import { DAY_MS, H4_MS, HOUR_MS } from "../src/signals/mtf.js";
import { SignalServiceV2 } from "../src/signals/service.v2.js";
import { SignalStore } from "../src/signals/store.js";
import type { Candle } from "../src/types/index.js";

const logger = createLogger({ level: "silent", pretty: false });
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-lastcheck-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Flat candles: there is never a setup, so every check ends with a reason. */
function flat(size: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ time: i * size, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10, closed: true }));
}

describe("the engine reports why there is no signal", () => {
  it("remembers the latest check per symbol, with a plain-English reason, and shows it on the dashboard", async () => {
    const store = new SignalStore(join(dir, "signals.json"), logger);
    store.load();
    let now = 1_000_000;
    const service = new SignalServiceV2({
      market: {
        getFreshCandles: async (_s, interval) => (interval === "1h" ? flat(HOUR_MS, 300) : interval === "4h" ? flat(H4_MS, 300) : flat(DAY_MS, 400)),
      },
      stream: new EventEmitter() as never,
      store,
      settings: { get: () => ({ ...DEFAULT_SIGNAL_SETTINGS, triggerTimeframe: "1h" as const }) },
      logger,
      now: () => now,
    });
    expect(service.lastChecks()).toEqual({});

    expect(await service.processHour("BTCUSDT")).toBeNull();
    const check = service.lastChecks().BTCUSDT!;
    expect(check).toMatchObject({ at: now, signal: false, candleTime: 299 * HOUR_MS });
    expect(typeof check.reason).toBe("string");
    expect(check.reason!.length).toBeGreaterThan(3);
    expect(service.lastChecks().ETHUSDT).toBeUndefined();

    now += 1000;
    await service.processHour("BTCUSDT");
    expect(service.lastChecks().BTCUSDT!.at).toBe(now); // replaced by the newer check

    const dashboard = new DashboardService({
      market: {
        getPrice: async (symbol: string) => ({ symbol, price: 100, change24h: 0, changePercent24h: 0, source: "binance" }) as never,
        getCandles: async (symbol: string, interval: string) => ({ symbol, interval, source: "binance", candles: flat(HOUR_MS, 30) }) as never,
        getPivots: async (symbol: string) => ({ symbol, basis: "daily", date: "2026-11-05", S3: 70, S2: 80, S1: 90, P: 100, R1: 110, R2: 120, R3: 130 }) as never,
      },
      settings: { get: () => ({ signals: { ...DEFAULT_SIGNAL_SETTINGS, timeframe: "1h" }, symbols: { enabled: ["BTCUSDT", "ETHUSDT"] } }) as never },
      signals: store,
      lastChecks: () => service.lastChecks(),
      now: () => now,
    });
    const out = await dashboard.get();
    expect(out.symbols.find((s) => s.symbol === "BTCUSDT")!.lastCheck).toMatchObject({ signal: false });
    expect(out.symbols.find((s) => s.symbol === "ETHUSDT")!.lastCheck).toBeNull();
  });
});

describe("live trigger timeframe", () => {
  const m15 = 15 * 60_000;
  function build(trigger: "15m" | "1h" | "4h") {
    const store = new SignalStore(join(dir, `signals-${trigger}.json`), logger);
    store.load();
    const asked: string[] = [];
    const service = new SignalServiceV2({
      market: {
        getFreshCandles: async (_s, interval) => {
          asked.push(interval);
          return interval === "15m" ? flat(m15, 300) : interval === "1h" ? flat(HOUR_MS, 300) : interval === "4h" ? flat(H4_MS, 300) : flat(DAY_MS, 400);
        },
      },
      stream: new EventEmitter() as never,
      store,
      settings: { get: () => ({ ...DEFAULT_SIGNAL_SETTINGS, triggerTimeframe: trigger }) },
      logger,
    });
    return { service, asked };
  }

  it("the default live trigger is 15m", () => {
    expect(DEFAULT_SIGNAL_SETTINGS.triggerTimeframe).toBe("15m");
  });

  it("15m: loads 15-minute candles as the trigger and evaluates the newest closed one", async () => {
    const { service, asked } = build("15m");
    await service.processHour("BTCUSDT");
    expect(asked).toContain("15m");
    expect(asked).not.toContain("1h");
    expect(service.lastChecks().BTCUSDT).toMatchObject({ candleTime: 299 * m15, signal: false });
  });

  it("1h: loads hourly candles; 4h: needs no separate trigger download", async () => {
    const one = build("1h");
    await one.service.processHour("BTCUSDT");
    expect(one.asked).toContain("1h");
    expect(one.asked).not.toContain("15m");
    const four = build("4h");
    await four.service.processHour("BTCUSDT");
    expect(four.asked).not.toContain("1h");
    expect(four.asked).not.toContain("15m");
    expect(four.service.lastChecks().BTCUSDT).toMatchObject({ candleTime: 299 * H4_MS });
  });
});

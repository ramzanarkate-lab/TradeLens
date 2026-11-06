import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_SETTINGS, type SignalSettings } from "../src/config/signalDefaults.js";
import type { Symbol } from "../src/config/symbols.js";
import { SignalEngine } from "../src/signals/engine.js";
import { StaticSignalSettings } from "../src/signals/settingsProvider.js";
import type { Candle, PivotLevels, Signal } from "../src/types/index.js";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

/**
 * Fixed series: 10 falling closes, then a rise. With EMA(3)/EMA(5) and RSI(5):
 *   index 11: EMA3 13.000 <= EMA5 13.111 (below)
 *   index 12: EMA3 14.500 >  EMA5 14.074 (cross up), RSI 62.35, close 16 > previous close 14
 * and no other crossover in the series.
 */
const CLOSES = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 12, 14, 16, 18, 20, 22, 24, 26];
const CROSS_INDEX = 12;

const settings = (over: Partial<SignalSettings> = {}): SignalSettings => ({
  ...DEFAULT_SIGNAL_SETTINGS,
  timeframe: "1h",
  emaFast: 3,
  emaSlow: 5,
  rsiPeriod: 5,
  rsiBuyMin: 30,
  rsiBuyMax: 80,
  rsiSellAbove: 99, // effectively off
  cooldownMinutes: 60,
  ...over,
});

const pivots = (over: Partial<PivotLevels> = {}): PivotLevels => ({
  P: 15, R1: 1e8, R2: 1e9, R3: 1e10, S1: 0, S2: -1, S3: -2, ...over,
});

function candles(closes: number[], startTime = T0, lastClosed = true): Candle[] {
  return closes.map((close, i) => ({
    time: startTime + i * HOUR,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
    closed: i < closes.length - 1 || lastClosed,
  }));
}

/** Feeds the series to the engine one closed candle at a time; returns [index, signal] pairs. */
function run(engine: SignalEngine, closes: number[], p: PivotLevels, symbol: Symbol = "BTCUSDT"): Array<[number, Signal]> {
  const out: Array<[number, Signal]> = [];
  for (let i = 0; i < closes.length; i++) {
    const s = engine.evaluate({ symbol, timeframe: "1h", candles: candles(closes.slice(0, i + 1)), pivots: p });
    if (s) out.push([i, s]);
  }
  return out;
}

const engineWith = (over: Partial<SignalSettings> = {}) => new SignalEngine(new StaticSignalSettings(settings(over)));

describe("SignalEngine", () => {
  it("EMA crossover produces exactly one BUY, at the expected index", () => {
    const signals = run(engineWith(), CLOSES, pivots());
    expect(signals).toHaveLength(1);
    const [index, signal] = signals[0]!;
    expect(index).toBe(CROSS_INDEX);
    expect(signal).toMatchObject({
      symbol: "BTCUSDT",
      side: "BUY",
      timeframe: "1h",
      trigger: "ema_cross_up",
      price: 16,
      createdAt: T0 + CROSS_INDEX * HOUR + HOUR, // close time of the candle that produced it
    });
    expect(signal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(signal.indicators.emaFast).toBeCloseTo(14.5, 4);
    expect(signal.indicators.emaSlow).toBeCloseTo(14.0741, 4);
    expect(signal.indicators.rsi).toBeCloseTo(62.3529, 3);
    expect(signal.levels).toEqual({ S1: 0, R2: 1e9, pivots: pivots() });
    expect(signal.reason).toContain("EMA 3 crossed above EMA 5");
    expect(signal.reason).toContain("RSI 62.4");
    expect(signal.reason).toContain("S1");
  });

  it("RSI outside the band blocks the BUY", () => {
    // RSI at the cross is 62.35
    expect(run(engineWith({ rsiBuyMax: 60 }), CLOSES, pivots())).toHaveLength(0);
    expect(run(engineWith({ rsiBuyMin: 70 }), CLOSES, pivots())).toHaveLength(0);
    // control: widening the band lets it through
    expect(run(engineWith({ rsiBuyMin: 62, rsiBuyMax: 63 }), CLOSES, pivots())).toHaveLength(1);
  });

  it("price below S1 blocks the BUY", () => {
    expect(run(engineWith(), CLOSES, pivots({ S1: 16.5 }))).toHaveLength(0); // close at the cross is 16
    expect(run(engineWith(), CLOSES, pivots({ S1: 16 }))).toHaveLength(1); // "at or above" S1
  });

  it("cooldown blocks a second BUY within 60 minutes and allows one after", () => {
    const engine = engineWith({ cooldownMinutes: 60 });
    const buyAt = (offsetMinutes: number, symbol: Symbol = "BTCUSDT") =>
      engine.evaluate({
        symbol,
        timeframe: "1h",
        candles: candles(CLOSES.slice(0, CROSS_INDEX + 1), T0 + offsetMinutes * 60_000),
        pivots: pivots(),
      });

    expect(buyAt(0)?.side).toBe("BUY");
    expect(buyAt(30)).toBeNull(); // 30 min later: blocked
    expect(buyAt(59)).toBeNull(); // 59 min later: blocked
    expect(buyAt(60)?.side).toBe("BUY"); // 60 min after the first: allowed
    expect(buyAt(90)).toBeNull(); // 30 min after the second: blocked again
    expect(buyAt(120, "SOLUSDT")?.side).toBe("BUY"); // cooldown is per symbol
  });

  it("SELL at R2 fires", () => {
    // R2 = 25: the close reaches 26 at index 17
    const signals = run(engineWith(), CLOSES, pivots({ R2: 25 }));
    expect(signals.map(([i, s]) => [i, s.side])).toEqual([[CROSS_INDEX, "BUY"], [17, "SELL"]]);
    const sell = signals[1]![1];
    expect(sell).toMatchObject({ trigger: "r2_reached", price: 26 });
    expect(sell.reason).toContain("reached resistance R2");
    expect(sell.levels.R2).toBe(25);
  });

  it("SELL on RSI above the threshold and on EMA cross down", () => {
    // RSI first exceeds 70 at index 13 (72.47); the BUY at index 12 (RSI 62.35) fires first.
    // With 1h candles and a 60-minute cooldown, a repeat exactly 60 minutes later is allowed,
    // so the RSI SELL fires again on every following candle while RSI stays above 70.
    const rsiSell = run(engineWith({ rsiSellAbove: 70 }), CLOSES, pivots());
    expect(rsiSell.map(([i, s]) => [i, s.side, s.trigger])).toEqual([
      [CROSS_INDEX, "BUY", "ema_cross_up"],
      [13, "SELL", "rsi_overbought"],
      [14, "SELL", "rsi_overbought"],
      [15, "SELL", "rsi_overbought"],
      [16, "SELL", "rsi_overbought"],
      [17, "SELL", "rsi_overbought"],
    ]);
    // A 180-minute cooldown suppresses the repeats: 13, then 16 (exactly 180 minutes later).
    const throttled = run(engineWith({ rsiSellAbove: 70, cooldownMinutes: 180 }), CLOSES, pivots());
    expect(throttled.filter(([, s]) => s.side === "SELL").map(([i]) => i)).toEqual([13, 16]);

    // Falling after the rise: EMA3 drops below EMA5
    const closes = [...CLOSES.slice(0, 15), 10, 8, 6, 5];
    const down = run(engineWith(), closes, pivots()).filter(([, s]) => s.side === "SELL");
    expect(down).toHaveLength(1);
    expect(down[0]![1].trigger).toBe("ema_cross_down");
    expect(down[0]![1].reason).toContain("EMA 3 crossed below EMA 5");
  });

  it("an incomplete candle produces no signal", () => {
    const cross = CLOSES.slice(0, CROSS_INDEX + 1);
    const forming = new SignalEngine(new StaticSignalSettings(settings()));
    expect(forming.evaluate({ symbol: "BTCUSDT", timeframe: "1h", candles: candles(cross, T0, false), pivots: pivots() })).toBeNull();

    // control: the same data with the last candle closed gives the BUY
    const closedEngine = new SignalEngine(new StaticSignalSettings(settings()));
    expect(closedEngine.evaluate({ symbol: "BTCUSDT", timeframe: "1h", candles: candles(cross, T0, true), pivots: pivots() })?.side).toBe("BUY");
  });

  it("a forming candle never feeds the indicators", () => {
    // Closed history stops before the cross; the forming candle would complete it.
    const history = candles(CLOSES.slice(0, CROSS_INDEX)); // all closed, ends at index 11 (no cross)
    const forming: Candle = { ...candles(CLOSES.slice(0, CROSS_INDEX + 1))[CROSS_INDEX]!, closed: false };
    const engine = engineWith();
    expect(engine.evaluate({ symbol: "BTCUSDT", timeframe: "1h", candles: [...history, forming], pivots: pivots() })).toBeNull();
  });

  it("evaluates each closed candle only once", () => {
    const engine = engineWith();
    const input = { symbol: "BTCUSDT" as const, timeframe: "1h" as const, candles: candles(CLOSES.slice(0, CROSS_INDEX + 1)), pivots: pivots() };
    expect(engine.evaluate(input)?.side).toBe("BUY");
    expect(engine.evaluate(input)).toBeNull();
  });

  it("emits nothing when disabled or without enough history", () => {
    expect(run(engineWith({ enabled: false }), CLOSES, pivots())).toHaveLength(0);
    const short = new SignalEngine(new StaticSignalSettings(settings()));
    expect(short.evaluate({ symbol: "BTCUSDT", timeframe: "1h", candles: candles([1, 2, 3]), pivots: pivots() })).toBeNull();
  });
});

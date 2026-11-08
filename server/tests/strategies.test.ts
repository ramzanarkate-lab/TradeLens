import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COSTS } from "../src/backtest/backtest.js";
import { atr, bollinger, macd } from "../src/signals/indicators.js";
import { buildRow, partStats, statusFor } from "../src/strategies/backtestStore.js";
import { dcaFills, dcaNetR, simulateDca } from "../src/strategies/dca.js";
import { expiryBarsFor, netR, simulateStandard, stepBar, tickExit, type SimulatedTrade } from "../src/strategies/engine.js";
import { emptyGrid, GRID, stepGrid } from "../src/strategies/grid.js";
import {
  BollingerMeanReversion,
  BreakoutPlusRetest,
  DcaAccumulator,
  EmaCrossover12_50,
  isRegularCoin,
  MacdHistogramExpansion,
  MovingAverageScalper,
  RsiOversoldRebound,
  STRATEGIES,
  supertrend,
  SupertrendMomentum,
  supportAt,
  SupportResistanceBounce,
  UnusualVolumeGainers,
  VolatilityBreakout,
} from "../src/strategies/library.js";
import { periodFor, runAllBacktests } from "../src/strategies/runBacktest.js";
import type { Candle } from "../src/types/index.js";

const HOUR = 3_600_000;
const ctx = { symbol: "BTCUSDT" };

/** Flat candles at 100 (high 100.5, low 99.5), volume 100. */
function flat(n: number, tfMs = HOUR): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: i * tfMs, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100, closed: true }));
}
const set = (c: Candle[], i: number, over: Partial<Candle>) => void Object.assign(c[i]!, over);
/** Candles from a list of closes (open = the previous close). */
function fromCloses(closes: number[], volume = 100, tfMs = HOUR): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return { time: i * tfMs, open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, volume, closed: true };
  });
}
/** Candles that stay inside a 100.8 entry's stop (99.79) and target (103.82). */
const calmAfter = (c: Candle[], from: number) => {
  for (let i = from; i < c.length; i++) set(c, i, { open: 100.8, close: 100.8, high: 101, low: 100.5, volume: 100 });
};

describe("the library", () => {
  it("has the 12 strategies in order, each on its own timeframe", () => {
    expect(STRATEGIES.map((s) => `${s.number}:${s.id}:${s.timeframe}:${s.kind}`)).toEqual([
      "1:RsiOversoldRebound:4h:standard",
      "2:MovingAverageScalper:15m:standard",
      "3:VolatilityBreakout:1h:standard",
      "4:DcaAccumulator:1h:dca",
      "5:SupertrendMomentum:4h:standard",
      "6:GridTrading:1h:grid",
      "7:SupportResistanceBounce:4h:standard",
      "8:BollingerMeanReversion:1h:standard",
      "9:BreakoutPlusRetest:1h:standard",
      "10:MacdHistogramExpansion:1h:standard",
      "11:UnusualVolumeGainers:1h:standard",
      "12:EmaCrossover12_50:1h:standard",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("1. RsiOversoldRebound (4h)", () => {
  const falling = () => {
    const c = fromCloses(Array.from({ length: 40 }, (_, i) => 100 - i));
    set(c, 39, { volume: 300 });
    return c;
  };

  it("enters when RSI(14) < 30 and the volume is above its 20-period average; stop -3%, target +5%", () => {
    const plan = RsiOversoldRebound.create(falling(), ctx).signal(39)!;
    expect(plan).not.toBeNull();
    const levels = plan.levels(60);
    expect(levels.stopLoss).toBeCloseTo(58.2, 6);
    expect(levels.targets[0]).toBeCloseTo(63, 6);
  });

  it("does not enter on a normal volume", () => {
    const c = falling();
    set(c, 39, { volume: 100 });
    expect(RsiOversoldRebound.create(c, ctx).signal(39)).toBeNull();
  });

  it("exits when RSI(14) rises above 70", () => {
    const rising = fromCloses(Array.from({ length: 40 }, (_, i) => 100 + i));
    const plan = RsiOversoldRebound.create(rising, ctx).plan(0);
    expect(plan.onClose!(30, { entry: 100, stop: 97, entryIndex: 1 })).toEqual({ exit: "RSI(14) > 70" });
    expect(RsiOversoldRebound.create(falling(), ctx).plan(0).onClose!(30, { entry: 100, stop: 97, entryIndex: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("2. MovingAverageScalper (15m)", () => {
  const closes = () => [...Array(20).fill(100), 99, 99, 99, 99, 101, 101, 98];
  it("enters when the close crosses above SMA(20) and is above the close 3 bars ago; stop -1%, target +2%", () => {
    const inst = MovingAverageScalper.create(fromCloses(closes()), ctx);
    expect(inst.signal(23)).toBeNull(); // still below the average
    const plan = inst.signal(24)!;
    expect(plan).not.toBeNull();
    expect(plan.levels(101).stopLoss).toBeCloseTo(99.99, 6);
    expect(plan.levels(101).targets[0]).toBeCloseTo(103.02, 6);
  });

  it("does not enter when the close is not above the close 3 bars ago", () => {
    // the close at index 24 (100.9) crosses above the average (about 100.1) but is below the close 3 bars earlier (102)
    const c = [...Array(20).fill(100), 103, 102, 98, 99, 100.9];
    const inst = MovingAverageScalper.create(fromCloses(c), ctx);
    expect(inst.signal(24)).toBeNull();
    c[21] = 100.5; // with 3 bars ago at 100.5 it is a valid entry
    expect(MovingAverageScalper.create(fromCloses(c), ctx).signal(24)).not.toBeNull();
  });

  it("exits when the close crosses back below the average", () => {
    const plan = MovingAverageScalper.create(fromCloses(closes()), ctx).plan(24);
    expect(plan.onClose!(25, { entry: 101, stop: 99.99, entryIndex: 25 })).toBeNull();
    expect(plan.onClose!(26, { entry: 101, stop: 99.99, entryIndex: 25 })).toEqual({ exit: "close crossed back below SMA(20)" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("3. VolatilityBreakout (1h)", () => {
  /** 40 quiet candles, then a breakout candle (39) on volume with a wider range. */
  function breakout(): Candle[] {
    const c = flat(45);
    set(c, 39, { open: 100, high: 103.2, low: 100, close: 103, volume: 200 });
    set(c, 40, { open: 103, high: 104.2, low: 102.8, close: 104, volume: 100 });
    return c;
  }

  it("enters on a close above the previous 24-bar high, with volume 1.5x its average and a rising ATR(14)", () => {
    expect(VolatilityBreakout.create(breakout(), ctx).signal(39)).not.toBeNull();
    const weakVolume = breakout();
    set(weakVolume, 39, { volume: 140 });
    expect(VolatilityBreakout.create(weakVolume, ctx).signal(39)).toBeNull();
    const noBreak = breakout();
    set(noBreak, 39, { close: 100.4, high: 100.5 });
    expect(VolatilityBreakout.create(noBreak, ctx).signal(39)).toBeNull();
  });

  it("has no fixed target; the first stop is the signal close minus 2x ATR(14)", () => {
    const c = breakout();
    const plan = VolatilityBreakout.create(c, ctx).signal(39)!;
    const levels = plan.levels(103.1);
    expect(levels.targets).toEqual([]);
    expect(levels.stopLoss).toBeCloseTo(103 - 2 * atr(c, 14)[39]!, 9);
  });

  it("trails the stop: the highest close since entry minus 2x ATR(14), and the engine only ever raises it", () => {
    const c = breakout();
    const plan = VolatilityBreakout.create(c, ctx).plan(39);
    const a = atr(c, 14);
    expect(plan.onClose!(40, { entry: 103, stop: 0, entryIndex: 40 })).toEqual({ stop: 104 - 2 * a[40]! });
    // through the engine: price keeps rising, then falls through the trailing stop
    const series = breakout().slice(0, 41);
    for (let i = 41; i < 48; i++) series.push({ time: i * HOUR, open: 104 + (i - 40), high: 105 + (i - 40), low: 103.5 + (i - 40), close: 104.8 + (i - 40), volume: 100, closed: true });
    series.push({ time: 48 * HOUR, open: 111, high: 111, low: 100, close: 101, volume: 100, closed: true });
    series.push(...flat(3).map((x, k) => ({ ...x, time: (49 + k) * HOUR, open: 101, high: 101, low: 100.5, close: 101 })));
    const trades = simulateStandard(VolatilityBreakout, series, ctx, 30);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ reason: "SL" });
    expect(trades[0]!.exitPrice).toBeGreaterThan(trades[0]!.stopLoss); // the stop had moved up with the price
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("4. DcaAccumulator (1h)", () => {
  const candles = () => {
    const c = flat(20);
    for (let i = 0; i < 20; i++) set(c, i, { open: 100 + (i >= 6 ? (i - 5) * 0.5 : 0) });
    return c; // opens: 100 up to candle 5, then 100.5, 101, 101.5, 102, 102.5 ...
  };

  it("never creates its own entries", () => {
    const inst = DcaAccumulator.create(flat(50), ctx);
    for (let i = 0; i < 50; i++) expect(inst.signal(i)).toBeNull();
  });

  it("buys 25% at the parent's entry, then 6 hourly parts of 12.5% at each candle's open, while price <= entry +2%", () => {
    const c = flat(20);
    const fills = dcaFills(c, 5, 100, 15);
    expect(fills).toHaveLength(7);
    expect(fills.map((f) => f.weight)).toEqual([0.25, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125]);
    expect(fills.reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1, 10);
    expect(fills.map((f) => f.time)).toEqual([5, 6, 7, 8, 9, 10, 11].map((i) => i * HOUR));
  });

  it("cancels the remainder the first time price is above the first entry +2%", () => {
    const c = candles();
    set(c, 9, { open: 102.5 }); // above 100 x 1.02
    const fills = dcaFills(c, 5, 100, 15);
    expect(fills.map((f) => f.time)).toEqual([5, 6, 7, 8].map((i) => i * HOUR)); // candle 9 and everything after is cancelled
  });

  it("stops buying once the parent has closed", () => {
    expect(dcaFills(flat(20), 5, 100, 7)).toHaveLength(3); // parent left in candle 7: parts at the opens of candles 6 and 7
  });

  it("applies the parent's exit to the full position: one tranche equals 25% of the parent's result", () => {
    const parentR = netR(100, 99, 103);
    expect(dcaNetR([{ time: 0, price: 100, weight: 0.25 }], 103, 99, 100)).toBeCloseTo(0.25 * parentR, 9);
    expect(dcaNetR([{ time: 0, price: 100, weight: 1 }], 103, 99, 100)).toBeCloseTo(parentR, 9);
  });

  it("follows one parent at a time per symbol", () => {
    const c = flat(60);
    const trade = (createdAt: number, entryIndex: number, exitIndex: number): SimulatedTrade => ({
      strategyId: "P", createdAt, entryTime: entryIndex * HOUR, entryIndex, entry: 100, stopLoss: 99, exitTime: (exitIndex + 1) * HOUR, exitIndex, exitPrice: 102, reason: "TP", netR: 1, returnPercent: 2,
    });
    const out = simulateDca("DcaAccumulator", c, [trade(10 * HOUR, 10, 20), trade(15 * HOUR, 15, 18), trade(30 * HOUR, 30, 35)]);
    expect(out.map((t) => t.entryIndex)).toEqual([10, 30]); // the one that arrived while DCA was open is not followed
    expect(out[0]!.strategyId).toBe("DcaAccumulator");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("5. SupertrendMomentum (4h)", () => {
  /** Down, then a sharp rally (Supertrend flips bullish), then down again (it flips bearish). */
  function vShape(): Candle[] {
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) closes.push(100 - i * 0.6);
    for (let i = 0; i < 40; i++) closes.push(70 + i * 1.5);
    for (let i = 0; i < 40; i++) closes.push(130 - i * 1.8);
    return fromCloses(closes, 100, 4 * HOUR);
  }

  it("enters when Supertrend(10,3) flips bullish with the MACD histogram above zero and rising; stop -3%, no target", () => {
    const c = vShape();
    const dir = supertrend(c, 10, 3);
    const hist = macd(c.map((x) => x.close)).histogram;
    const inst = SupertrendMomentum.create(c, ctx);
    const signals = c.map((_, i) => i).filter((i) => inst.signal(i));
    expect(signals.length).toBeGreaterThan(0);
    for (const i of signals) {
      expect(dir[i - 1]).toBe(-1);
      expect(dir[i]).toBe(1);
      expect(hist[i]).toBeGreaterThan(0);
      expect(hist[i]).toBeGreaterThan(hist[i - 1]!);
    }
    const levels = inst.signal(signals[0]!)!.levels(100);
    expect(levels.stopLoss).toBeCloseTo(97, 9);
    expect(levels.targets).toEqual([]);
  });

  it("exits when Supertrend flips bearish", () => {
    const c = vShape();
    const dir = supertrend(c, 10, 3);
    const inst = SupertrendMomentum.create(c, ctx);
    const flip = dir.findIndex((d, i) => i > 90 && d === -1);
    expect(flip).toBeGreaterThan(90);
    expect(inst.plan(0).onClose!(flip - 1, { entry: 1, stop: 0, entryIndex: 1 })).toBeNull();
    expect(inst.plan(0).onClose!(flip, { entry: 1, stop: 0, entryIndex: 1 })).toEqual({ exit: "Supertrend flipped bearish" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("6. GridTrading (1h)", () => {
  /** 20 candles with a 90-100 range, closing at 95. The 10 levels are 90, 91.11, ... 100. */
  const rangeCandles = (close = 95): Candle[] => Array.from({ length: 20 }, (_, i) => ({ time: i * HOUR, open: close, high: 100, low: 90, close, volume: 100, closed: true }));
  const next = (over: Partial<Candle>, i = 20): Candle => ({ time: i * HOUR, open: 95, high: 96, low: 94.9, close: 95, volume: 100, closed: true, ...over });
  const step = (state: ReturnType<typeof emptyGrid>, c: Candle, history: Candle[]) => stepGrid(state, c, [...history, c].slice(-GRID.lookback), HOUR, "G");

  it("sets up 10 evenly spaced levels across the last 20 bars' range", () => {
    const state = emptyGrid();
    step(state, rangeCandles().at(-1)!, rangeCandles());
    expect(state.grid!.low).toBe(90);
    expect(state.grid!.high).toBe(100);
    expect(state.grid!.levels).toHaveLength(10);
    expect(state.grid!.levels[1]! - state.grid!.levels[0]!).toBeCloseTo(10 / 9, 9);
  });

  it("buys each level below the previous close that the candle's low reaches, and sells one level above", () => {
    const state = emptyGrid();
    const history = rangeCandles();
    step(state, history.at(-1)!, history.slice(0, -1));
    const fills = step(state, next({ low: 92 }), history).filter((e) => e.type === "fill");
    expect(fills.map((e) => (e as { position: { levelIndex: number } }).position.levelIndex)).toEqual([4, 3, 2]); // 94.44, 93.33, 92.22 (not 91.11)
    const first = (fills[0] as { position: { fillPrice: number; sellLevel: number } }).position;
    expect(first.fillPrice).toBeCloseTo(90 + 4 * (10 / 9), 9);
    expect(first.sellLevel).toBeCloseTo(90 + 5 * (10 / 9), 9);
    expect(state.positions).toHaveLength(3);
    // a position does not sell on the candle it filled in; the next candle that reaches its sell level closes it
    const sells = step(state, next({ high: 96, low: 95 }, 21), history).filter((e) => e.type === "close");
    expect(sells.map((e) => (e as { reason: string }).reason)).toEqual(["TP", "TP", "TP"]);
    expect(state.positions).toHaveLength(0);
  });

  it("holds at most 5 open positions", () => {
    const state = emptyGrid();
    const history = rangeCandles(99.5);
    step(state, history.at(-1)!, history.slice(0, -1));
    step(state, next({ open: 99.5, high: 99.5, low: 89.5, close: 91 }), history);
    expect(state.positions).toHaveLength(GRID.maxOpen);
  });

  it("closes every position when the close is more than 3% outside the range, and sets the grid up again", () => {
    const state = emptyGrid();
    const history = rangeCandles();
    step(state, history.at(-1)!, history.slice(0, -1));
    step(state, next({ low: 92 }), history);
    const events = step(state, next({ open: 100, high: 105, low: 99, close: 104 }, 21), history);
    const closes = events.filter((e) => e.type === "close") as Array<{ reason: string; price: number }>;
    expect(closes.length).toBeGreaterThan(0);
    expect(closes.every((e) => e.reason === "EXIT_ALL" || e.reason === "TP")).toBe(true);
    expect(state.positions).toHaveLength(0);
    expect(state.grid).not.toBeNull(); // a new grid from the latest 20 bars
  });

  it("closes a position at market after 24 hours", () => {
    const state = emptyGrid();
    const history = rangeCandles();
    step(state, history.at(-1)!, history.slice(0, -1));
    step(state, next({ low: 92 }), history);
    const events = step(state, next({ open: 92.8, high: 93, low: 92.6, close: 92.8 }, 20 + 24), history).filter((e) => e.type === "close") as Array<{ reason: string }>;
    expect(events.map((e) => e.reason)).toEqual(["EXPIRED", "EXPIRED", "EXPIRED"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("7. SupportResistanceBounce (4h)", () => {
  /** Lows at 100 with one swing low of 90 at candle 20 (the 3 bars on each side are higher). */
  function withPivot(n = 60): Candle[] {
    const c = flat(n, 4 * HOUR);
    for (const c1 of c) Object.assign(c1, { low: 100, open: 101, close: 101, high: 102 });
    set(c, 20, { low: 90, open: 91, close: 91, high: 95 });
    return c;
  }

  it("finds the lowest swing low in the last 50 bars, usable only after 3 bars closed past it", () => {
    const c = withPivot();
    expect(supportAt(c, 22)).toBeNull(); // only 2 bars after the pivot
    expect(supportAt(c, 23)).toBe(90);
    expect(supportAt(c, 59)).toBe(90);
    expect(supportAt(withPivot(80), 75)).toBeNull(); // the pivot is more than 50 bars back
  });

  it("enters on a bullish candle whose low is within 0.5% of the support; target +4%, stop 1% below the support", () => {
    const c = withPivot();
    set(c, 30, { low: 90.3, open: 90.4, close: 92 });
    const inst = SupportResistanceBounce.create(c, ctx);
    const plan = inst.signal(30)!;
    expect(plan).not.toBeNull();
    const levels = plan.levels(91);
    expect(levels.stopLoss).toBeCloseTo(89.1, 9);
    expect(levels.targets[0]).toBeCloseTo(94.64, 9);
    set(c, 31, { low: 90.3, open: 92, close: 91 }); // a bearish candle
    expect(SupportResistanceBounce.create(c, ctx).signal(31)).toBeNull();
    set(c, 32, { low: 91, open: 91, close: 92 }); // low not within 0.5% of 90
    expect(SupportResistanceBounce.create(c, ctx).signal(32)).toBeNull();
  });

  it("does not use a pivot before 3 bars have closed past it (no look-ahead)", () => {
    const c = withPivot();
    set(c, 22, { low: 90.2, open: 90.3, close: 92 });
    expect(SupportResistanceBounce.create(c, ctx).signal(22)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("8. BollingerMeanReversion (1h)", () => {
  const closes = () => [...Array(25).fill(100), 99.5, 98.5, 97, 94];
  it("enters when the close is below the lower band(20,2) and RSI(14) < 35; stop -3%", () => {
    const c = fromCloses(closes());
    const bb = bollinger(c.map((x) => x.close), 20, 2);
    const inst = BollingerMeanReversion.create(c, ctx);
    const i = c.findIndex((x, k) => inst.signal(k) !== null);
    expect(i).toBeGreaterThan(24);
    expect(c[i]!.close).toBeLessThan(bb.lower[i]!);
    expect(inst.signal(i)!.levels(94).stopLoss).toBeCloseTo(91.18, 9);
    expect(inst.signal(24)).toBeNull();
  });

  it("exits when the close reaches the middle band (or the upper band)", () => {
    const c = fromCloses([...closes(), 95, 97, 99, 101]);
    const bb = bollinger(c.map((x) => x.close), 20, 2);
    const plan = BollingerMeanReversion.create(c, ctx).plan(28);
    expect(plan.onClose!(29, { entry: 94, stop: 91, entryIndex: 29 })).toBeNull(); // 95 < middle
    const j = c.findIndex((x, k) => k > 28 && x.close >= bb.middle[k]!);
    expect(plan.onClose!(j, { entry: 94, stop: 91, entryIndex: 29 })).toEqual({ exit: "close reached the middle band" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("9. BreakoutPlusRetest (1h)", () => {
  /** Quiet candles, a breakout on candle 30 (the broken level is 100.5), and a retest on candle 33. */
  function setup(): Candle[] {
    const c = flat(45);
    set(c, 30, { open: 100, high: 102.5, low: 100, close: 102, volume: 200 });
    for (const i of [31, 32]) set(c, i, { open: 102, high: 103, low: 101.8, close: 102.5, volume: 100 });
    set(c, 33, { open: 102, high: 102.5, low: 100.6, close: 101.5, volume: 100 }); // low within 0.3% of 100.5, closes above it
    return c;
  }

  it("enters on a candle within 10 bars of the breakout whose low is within 0.3% of the level and that closes above it", () => {
    const inst = BreakoutPlusRetest.create(setup(), ctx);
    expect(inst.signal(31)).toBeNull();
    const plan = inst.signal(33)!;
    expect(plan).not.toBeNull();
    const levels = plan.levels(101.5);
    expect(levels.stopLoss).toBeCloseTo(100.5 * 0.99, 9); // 1% below the level
    expect(levels.targets[0]).toBeCloseTo(101.5 * 1.03, 9);
  });

  it("needs the breakout to have volume above 1.5x its average", () => {
    const c = setup();
    set(c, 30, { volume: 140 });
    expect(BreakoutPlusRetest.create(c, ctx).signal(33)).toBeNull();
  });

  it("only trades the first retest, and only within 10 bars", () => {
    const c = setup();
    set(c, 35, { open: 102, high: 102.5, low: 100.6, close: 101.5 }); // a second retest of the same breakout
    expect(BreakoutPlusRetest.create(c, ctx).signal(35)).toBeNull();
    const late = setup();
    set(late, 33, { low: 102, close: 102.5 }); // no retest in time
    set(late, 41, { open: 102, high: 102.5, low: 100.6, close: 101.5 });
    expect(BreakoutPlusRetest.create(late, ctx).signal(41)).toBeNull(); // 11 bars after the breakout
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("10. MacdHistogramExpansion (1h)", () => {
  /** Flat, then an accelerating rise (the histogram expands), then a plateau (it contracts). */
  function series(): Candle[] {
    const closes: number[] = Array(70).fill(100);
    for (let k = 1; k <= 30; k++) closes.push(100 + k * k * 0.05);
    for (let k = 0; k < 25; k++) closes.push(145);
    return fromCloses(closes);
  }

  it("enters when the histogram is above zero and above its value 2 bars ago, with the close above EMA(50); stop -2%, target +4%", () => {
    const c = series();
    const hist = macd(c.map((x) => x.close)).histogram;
    const inst = MacdHistogramExpansion.create(c, ctx);
    const i = c.findIndex((_, k) => inst.signal(k) !== null);
    expect(i).toBeGreaterThanOrEqual(70);
    expect(hist[i]).toBeGreaterThan(0);
    expect(hist[i]).toBeGreaterThan(hist[i - 2]!);
    const levels = inst.signal(i)!.levels(100);
    expect(levels.stopLoss).toBeCloseTo(98, 9);
    expect(levels.targets[0]).toBeCloseTo(104, 9);
    expect(inst.signal(60)).toBeNull();
  });

  it("exits when the histogram contracts for 2 consecutive bars", () => {
    const c = series();
    const hist = macd(c.map((x) => x.close)).histogram;
    const plan = MacdHistogramExpansion.create(c, ctx).plan(80);
    const contracted = c.findIndex((_, k) => k > 80 && hist[k]! < hist[k - 1]! && hist[k - 1]! < hist[k - 2]!);
    expect(contracted).toBeGreaterThan(80);
    expect(plan.onClose!(contracted, { entry: 1, stop: 0, entryIndex: 1 })).toEqual({ exit: "histogram contracted for 2 bars" });
    expect(plan.onClose!(75, { entry: 1, stop: 0, entryIndex: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("11. UnusualVolumeGainers (1h)", () => {
  const spike = (volume: number, over: Partial<Candle> = {}, symbol = "BTCUSDT") => {
    const c = flat(20);
    set(c, 15, { volume, open: 100, close: 101, high: 101.2, ...over });
    return UnusualVolumeGainers.create(c, { symbol }).signal(15);
  };

  it("enters when volume is at least 2x the average of the 10 candles before it and the candle closed up; stop -1%, target +3%, 6 bars", () => {
    const plan = spike(200)!;
    expect(plan).not.toBeNull();
    expect(plan.levels(100.8).stopLoss).toBeCloseTo(99.792, 9);
    expect(plan.levels(100.8).targets[0]).toBeCloseTo(103.824, 9);
    expect(plan.maxBars).toBe(6);
    expect(spike(199)).toBeNull();
    expect(spike(500, { close: 99.9, low: 99.5 })).toBeNull(); // not a gainer
    expect(spike(500, { close: 100 })).toBeNull();
  });

  it("only regular coins: no stablecoins or leveraged tokens", () => {
    expect(isRegularCoin("BTCUSDT")).toBe(true);
    expect(isRegularCoin("SOLUSDT")).toBe(true);
    for (const s of ["USDCUSDT", "FDUSDUSDT", "DAIUSDT", "BTCUPUSDT", "ETHDOWNUSDT", "BNBBULLUSDT", "ETH3LUSDT", "BTC5SUSDT"]) expect(isRegularCoin(s)).toBe(false);
    expect(spike(500, {}, "USDCUSDT")).toBeNull();
    expect(spike(500, {}, "BTCUPUSDT")).toBeNull();
  });

  it("logs once that the market cap filter is skipped (the data has no market cap)", () => {
    const log = vi.fn();
    const c = flat(30);
    set(c, 15, { volume: 400, close: 101 });
    set(c, 20, { volume: 400, close: 101 });
    const inst = UnusualVolumeGainers.create(c, { symbol: "BTCUSDT", log });
    inst.signal(15);
    inst.signal(20);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("market cap");
  });

  it("through the engine: enters at the NEXT candle's open, exits at the target, at the stop, or after 6 bars", () => {
    const run = (mutate: (c: Candle[]) => void) => {
      const c = flat(40);
      set(c, 15, { volume: 400, close: 100.4, high: 100.5 });
      set(c, 16, { open: 100.8 }); // the next open is not the signal close (100.4)
      calmAfter(c, 16);
      mutate(c);
      return simulateStandard(UnusualVolumeGainers, c, ctx, 11);
    };
    const target = run((c) => set(c, 18, { high: 104 }));
    expect(target[0]).toMatchObject({ reason: "TP", entry: 100.8, entryIndex: 16 });
    expect(target[0]!.exitPrice).toBeCloseTo(103.824, 9);
    const stop = run((c) => set(c, 18, { low: 99 }));
    expect(stop[0]).toMatchObject({ reason: "SL" });
    expect(stop[0]!.exitPrice).toBeCloseTo(99.792, 9);
    const time = run(() => undefined);
    expect(time[0]).toMatchObject({ reason: "TIME", exitIndex: 21 }); // the 6th bar counting from the signal candle (15)
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("12. EmaCrossover12_50 (1h)", () => {
  function series(): Candle[] {
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) closes.push(100 - i * 0.5);
    for (let i = 0; i < 40; i++) closes.push(70 + i);
    for (let i = 0; i < 40; i++) closes.push(110 - i * 1.5);
    return fromCloses(closes);
  }

  it("enters when EMA(12) crosses above EMA(50); stop 2% below the entry, no target", () => {
    const c = series();
    const inst = EmaCrossover12_50.create(c, ctx);
    const entries = c.map((_, i) => i).filter((i) => inst.signal(i));
    expect(entries).toHaveLength(1);
    expect(entries[0]!).toBeGreaterThan(60);
    const levels = inst.signal(entries[0]!)!.levels(90);
    expect(levels.stopLoss).toBeCloseTo(88.2, 9);
    expect(levels.targets).toEqual([]);
  });

  it("exits when EMA(12) crosses back below EMA(50)", () => {
    const c = series();
    const plan = EmaCrossover12_50.create(c, ctx).plan(0);
    const exits = c.map((_, i) => i).filter((i) => plan.onClose!(i, { entry: 1, stop: 0, entryIndex: 1 }));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the backtest engine", () => {
  const spikeSeries = () => {
    const c = flat(40);
    set(c, 15, { volume: 400, close: 100.4, high: 100.5 });
    calmAfter(c, 16);
    set(c, 16, { open: 100 }); // entry at exactly 100: stop 99, target 103
    return c;
  };

  it("executes at the next candle's open, not at the signal close", () => {
    const c = spikeSeries();
    set(c, 16, { open: 100.9, high: 104 });
    const t = simulateStandard(UnusualVolumeGainers, c, ctx, 11)[0]!;
    expect(t.entry).toBe(100.9);
    expect(t.entry).not.toBe(c[15]!.close);
    expect(t.entryTime).toBe(c[16]!.time);
    expect(t.createdAt).toBe(c[15]!.time + HOUR); // the signal was made when candle 15 closed
  });

  it("the entry candle's own high and low can end the trade", () => {
    const c = spikeSeries();
    set(c, 16, { low: 98.5 });
    expect(simulateStandard(UnusualVolumeGainers, c, ctx, 11)[0]).toMatchObject({ reason: "SL", exitIndex: 16 });
  });

  it("when the stop and the target are both reached in one candle, the stop was hit first", () => {
    const c = spikeSeries();
    set(c, 17, { high: 104, low: 98.5 });
    const t = simulateStandard(UnusualVolumeGainers, c, ctx, 11)[0]!;
    expect(t.reason).toBe("SL");
    expect(t.exitPrice).toBeCloseTo(99, 9);
    expect(stepBar({ entry: 100, stop: 99, target: 103, expiryBars: 24 }, { open: 100, high: 104, low: 98, close: 100 }, 2)?.reason).toBe("SL");
  });

  it("a stop that is gapped through fills at the open", () => {
    expect(stepBar({ entry: 100, stop: 99, expiryBars: 24 }, { open: 97, high: 98, low: 96, close: 97.5 }, 1)).toEqual({ reason: "SL", price: 97 });
    expect(tickExit({ stop: 99 }, 98.2)).toEqual({ reason: "SL", price: 98.2 });
  });

  it("charges 0.1% per side and 0.05% slippage per fill", () => {
    const entry = 100;
    const stop = 99;
    const exit = 103;
    const entryFill = entry * 1.0005;
    const exitFill = exit * 0.9995;
    const expected = (exitFill - entryFill - 0.001 * (entryFill + exitFill)) / (entry - stop);
    expect(netR(entry, stop, exit)).toBeCloseTo(expected, 9);
    expect(netR(entry, stop, exit)).toBeCloseTo(2.6955, 3);
    expect(netR(entry, stop, exit, { feePerSide: 0, slippage: 0 })).toBeCloseTo(3, 9);
    expect(DEFAULT_COSTS).toEqual({ feePerSide: 0.001, slippage: 0.0005 });
    const c = spikeSeries();
    set(c, 17, { high: 104 });
    expect(simulateStandard(UnusualVolumeGainers, c, ctx, 11)[0]!.netR).toBeCloseTo(2.6955, 3); // through the engine: entry 100, stop 99, exit 103
  });

  it("closes any open position at market after 24 hours", () => {
    expect(expiryBarsFor("1h")).toBe(24);
    expect(expiryBarsFor("4h")).toBe(6);
    expect(expiryBarsFor("15m")).toBe(96);
    expect(stepBar({ entry: 100, stop: 90, expiryBars: 24 }, { open: 100, high: 101, low: 99, close: 100.5 }, 23)).toBeNull();
    expect(stepBar({ entry: 100, stop: 90, expiryBars: 24 }, { open: 100, high: 101, low: 99, close: 100.5 }, 24)).toEqual({ reason: "EXPIRED", price: 100.5 });
  });

  it("splits each period 70% in-sample and 30% out-of-sample by the time the signal was made", () => {
    const c = flat(1000);
    const p = periodFor(c, "1h", 60, 20);
    expect(p.startIndex).toBe(20);
    expect(p.splitAt).toBe(Math.floor(p.from + (p.to - p.from) * 0.7));
    const trade = (createdAt: number, netR: number): SimulatedTrade => ({ strategyId: "S", createdAt, entryTime: createdAt, entryIndex: 0, entry: 100, stopLoss: 99, exitTime: createdAt + 1, exitIndex: 0, exitPrice: 100, reason: "TP", netR, returnPercent: 0 });
    const row = buildRow({ strategyId: "S", symbol: "BTCUSDT", timeframe: "1h", from: 0, to: 1000, splitAt: 700, trades: [trade(10, 1), trade(699, 1), trade(700, -1), trade(900, -1)] });
    expect(row.inSample).toMatchObject({ trades: 2, expectancyR: 1 });
    expect(row.outOfSample).toMatchObject({ trades: 2, expectancyR: -1 });
  });

  it("an in-sample result never changes the out-of-sample one: the two parts are measured separately", () => {
    const mk = (n: number, netR: number, start: number): SimulatedTrade[] => Array.from({ length: n }, (_, i) => ({ strategyId: "S", createdAt: start + i, entryTime: 0, entryIndex: 0, entry: 100, stopLoss: 99, exitTime: start + i, exitIndex: 0, exitPrice: 100, reason: "TP" as const, netR, returnPercent: 0 }));
    const a = buildRow({ strategyId: "S", symbol: "X", timeframe: "1h", from: 0, to: 2000, splitAt: 1000, trades: [...mk(40, 5, 0), ...mk(40, -1, 1000)] });
    const b = buildRow({ strategyId: "S", symbol: "X", timeframe: "1h", from: 0, to: 2000, splitAt: 1000, trades: [...mk(40, -5, 0), ...mk(40, -1, 1000)] });
    expect(a.outOfSample).toEqual(b.outOfSample);
    expect(a.status).toBe(b.status);
  });

  it("status: fewer than 30 out-of-sample trades is INSUFFICIENT SAMPLE; a profit factor above 1.3 with a small drawdown is PASSED; a loser is NOT PASSED", () => {
    const t = (netR: number, i: number): SimulatedTrade => ({ strategyId: "S", createdAt: i, entryTime: i, entryIndex: 0, entry: 100, stopLoss: 99, exitTime: i, exitIndex: 0, exitPrice: 100, reason: "TP", netR, returnPercent: 0 });
    expect(statusFor(partStats(Array.from({ length: 20 }, (_, i) => t(i % 2 ? 2 : -1, i)))).status).toBe("INSUFFICIENT SAMPLE");
    expect(statusFor(partStats(Array.from({ length: 36 }, (_, i) => t(i % 9 < 4 ? 2 : -1, i)))).status).toBe("PASSED");
    expect(statusFor(partStats(Array.from({ length: 40 }, (_, i) => t(i % 5 === 0 ? 2 : -1, i)))).status).toBe("NOT PASSED");
  });

  it("runs all strategies on all symbols and reports a row for each, with every strategy NOT PASSED on flat data", () => {
    const rows = runAllBacktests({ symbols: ["BTCUSDT"], months: { "15m": 12, "1h": 60, "4h": 60 }, loadCandles: (_s, tf) => flat(400, tf === "15m" ? 900_000 : tf === "1h" ? HOUR : 4 * HOUR) });
    expect(rows.map((r) => r.strategyId)).toEqual(STRATEGIES.map((s) => s.id));
    expect(rows.every((r) => r.status !== "PASSED")).toBe(true);
  });
});

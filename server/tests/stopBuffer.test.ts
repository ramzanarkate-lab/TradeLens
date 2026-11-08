import { describe, expect, it } from "vitest";
import { parseStopBuffer } from "../src/backtest/backtest.js";
import { DEFAULT_SIGNAL_SETTINGS } from "../src/config/signalDefaults.js";
import { computeLevels, DEFAULT_STOP_BUFFER_ATR, type LevelInput } from "../src/signals/levels.js";
import { DEFAULT_SETTINGS, sectionSchemas } from "../src/settings/schema.js";
import type { PivotLevels } from "../src/types/index.js";

const pivots: PivotLevels = { P: 100, R1: 1000, R2: 1100, R3: 1200, S1: 99, S2: 90, S3: 80 };
const buy: LevelInput = { side: "BUY", entry: 100, atr: 2, recentLows: [99.5, 98.5, 98.2, 99, 99.2], recentHighs: [], pivots, decimals: 2, minRiskPercent: 0, maxRiskPercent: 100 };
const sell: LevelInput = { side: "SELL", entry: 100, atr: 2, recentHighs: [100.5, 101.8, 101, 100.2, 100.9], recentLows: [], pivots: { ...pivots, R1: 101, S1: 1, S2: 1, S3: 1 }, decimals: 2, minRiskPercent: 0, maxRiskPercent: 100 };
const stop = (input: LevelInput) => {
  const r = computeLevels(input);
  if (!r.ok) throw new Error(r.reason);
  return r.levels.sl;
};

describe("stop buffer", () => {
  it("the default is 0.5 x ATR, and a buffer of 0.5 gives the same stop as before (hard-coded 0.5)", () => {
    expect(DEFAULT_STOP_BUFFER_ATR).toBe(0.5);
    // BUY: min(lowest low 98.2, S1 99) - 0.5 x 2 = 97.2    SELL: max(highest high 101.8, R1 101) + 0.5 x 2 = 102.8
    expect(stop(buy)).toBe(97.2);
    expect(stop({ ...buy, stopBufferAtr: 0.5 })).toBe(97.2);
    expect(stop(sell)).toBe(102.8);
    expect(stop({ ...sell, stopBufferAtr: 0.5 })).toBe(102.8);
  });

  it("the same numbers as the unchanged ATR=1 sample in the level tests", () => {
    const sample = { ...buy, atr: 1 };
    expect(stop(sample)).toBe(97.7);
    expect(stop({ ...sample, stopBufferAtr: 0.5 })).toBe(97.7);
  });

  it("a buffer of 1.5 puts the stop exactly 1.0 x ATR further away, for BUY and SELL", () => {
    expect(stop({ ...buy, stopBufferAtr: 1.5 })).toBe(95.2);
    expect(stop(buy) - stop({ ...buy, stopBufferAtr: 1.5 })).toBeCloseTo(1.0 * buy.atr, 10);
    expect(stop({ ...sell, stopBufferAtr: 1.5 })).toBe(104.8);
    expect(stop({ ...sell, stopBufferAtr: 1.5 }) - stop(sell)).toBeCloseTo(1.0 * sell.atr, 10);
  });

  it("only the stop (and so the targets, which are multiples of the risk) change; entry stays", () => {
    const a = computeLevels(buy);
    const b = computeLevels({ ...buy, stopBufferAtr: 1.5 });
    if (!a.ok || !b.ok) throw new Error("expected levels");
    expect(a.levels.entry).toBe(b.levels.entry);
    expect(b.levels.rrTp1).toBe(1);
    expect(b.levels.riskPercent).toBeGreaterThan(a.levels.riskPercent);
  });
});

describe("stop buffer setting and the backtest option", () => {
  it("the engine setting defaults to 0.5 and accepts 0.1 to 3.0 only", () => {
    expect(DEFAULT_SETTINGS.signals.stopBufferAtr).toBe(0.5);
    expect(DEFAULT_SIGNAL_SETTINGS.stopBufferAtr).toBe(0.5);
    const ok = (v: unknown) => sectionSchemas.signals.safeParse({ ...DEFAULT_SETTINGS.signals, stopBufferAtr: v }).success;
    expect(ok(0.1)).toBe(true);
    expect(ok(1.5)).toBe(true);
    expect(ok(3)).toBe(true);
    expect(ok(0.09)).toBe(false);
    expect(ok(3.01)).toBe(false);
    expect(ok("1")).toBe(false);
  });

  it("the backtest uses 0.5 when no value is given and accepts values in range", () => {
    expect(parseStopBuffer(undefined)).toBe(0.5);
    expect(parseStopBuffer("1.5")).toBe(1.5);
    expect(parseStopBuffer("0.1")).toBe(0.1);
    expect(parseStopBuffer("3")).toBe(3);
  });

  it("the backtest rejects a buffer outside 0.1 to 3.0, and anything that is not a number", () => {
    for (const bad of ["0.09", "0", "-1", "3.01", "10", "abc", "", "NaN", "Infinity"]) {
      expect(() => parseStopBuffer(bad), bad).toThrow(/--stopBuffer must be a number from 0.1 to 3/);
    }
  });
});

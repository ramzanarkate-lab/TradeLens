import { describe, expect, it } from "vitest";
import { closedCloses, ema, rsi } from "../src/signals/indicators.js";
import type { Candle } from "../src/types/index.js";

const NaNs = (n: number) => Array(n).fill(Number.NaN);

describe("ema", () => {
  it("seeds with the simple average and then smooths (period 3)", () => {
    // seed = (1+2+3)/3 = 2 ; k = 0.5 ; 4*0.5 + 2*0.5 = 3 ; 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([...NaNs(2), 2, 3, 4]);
  });

  it("is flat for a flat series and has the same length as the input", () => {
    const out = ema([7, 7, 7, 7, 7, 7], 4);
    expect(out).toHaveLength(6);
    expect(out.slice(3)).toEqual([7, 7, 7]);
  });

  it("returns all NaN when there is not enough data or the period is invalid", () => {
    expect(ema([1, 2], 3)).toEqual(NaNs(2));
    expect(ema([1, 2, 3], 0)).toEqual(NaNs(3));
    expect(ema([], 3)).toEqual([]);
  });
});

describe("rsi (Wilder smoothing)", () => {
  it("period 2: 50 after the first window, then smoothed", () => {
    // changes +1, -1 -> avgGain 0.5, avgLoss 0.5 -> RSI 50
    // next +1: avgGain = (0.5*1 + 1)/2 = 0.75, avgLoss = (0.5*1 + 0)/2 = 0.25 -> RS 3 -> RSI 75
    const out = rsi([1, 2, 1, 2], 2);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out[2]).toBeCloseTo(50, 10);
    expect(out[3]).toBeCloseTo(75, 10);
  });

  it("period 3: 66.667 then 77.778", () => {
    // changes +1,-1,+1 -> avgGain 2/3, avgLoss 1/3 -> RS 2 -> 66.667
    // next +1: avgGain = (2/3*2 + 1)/3 = 7/9, avgLoss = (1/3*2)/3 = 2/9 -> RS 3.5 -> 77.778
    const out = rsi([10, 11, 10, 11, 12], 3);
    expect(out[3]).toBeCloseTo(66.6667, 4);
    expect(out[4]).toBeCloseTo(77.7778, 4);
  });

  it("is 100 when there are no losses, 0 when there are no gains, 50 when flat", () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3).slice(3)).toEqual([100, 100, 100]);
    expect(rsi([6, 5, 4, 3, 2, 1], 3).slice(3)).toEqual([0, 0, 0]);
    expect(rsi([5, 5, 5, 5, 5], 3).slice(3)).toEqual([50, 50]);
  });

  it("returns all NaN when there is not enough data", () => {
    expect(rsi([1, 2, 3], 3)).toEqual(NaNs(3));
  });
});

describe("closedCloses", () => {
  it("ignores candles that are still forming", () => {
    const c = (close: number, closed: boolean): Candle => ({ time: 0, open: close, high: close, low: close, close, volume: 1, closed });
    expect(closedCloses([c(1, true), c(2, true), c(3, false)])).toEqual([1, 2]);
  });
});

import { describe, expect, it } from "vitest";
import { adx, atr, bollinger, macd, sma, volumeRatio, volumeSma } from "../src/signals/indicators.js";

describe("SMA, MACD, ATR, ADX, Bollinger, volume (fixed data)", () => {
  it("sma matches hand-calculated values", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out.slice(2)).toEqual([2, 3, 4]);
  });

  it("macd of a constant series is zero; of a rising series the line is positive", () => {
    const flat = macd(new Array(60).fill(10));
    expect(flat.line[59]).toBeCloseTo(0, 10);
    expect(flat.signal[59]).toBeCloseTo(0, 10);
    expect(flat.histogram[59]).toBeCloseTo(0, 10);
    const up = macd(Array.from({ length: 80 }, (_, i) => 100 + i));
    expect(up.line[79]!).toBeGreaterThan(0);
    expect(Number.isNaN(up.line[24]!)).toBe(true); // the slow EMA(26) starts at index 25
    expect(Number.isNaN(up.signal[32]!)).toBe(true); // the signal starts 8 candles later
    expect(Number.isNaN(up.signal[33]!)).toBe(false);
  });

  it("atr of candles that are always 2 wide with no gaps is 2", () => {
    const candles = Array.from({ length: 30 }, () => ({ high: 11, low: 9, close: 10 }));
    const out = atr(candles, 14);
    expect(Number.isNaN(out[13]!)).toBe(true);
    expect(out[14]).toBeCloseTo(2, 10);
    expect(out[29]).toBeCloseTo(2, 10);
  });

  it("atr counts the gap from the previous close and smooths like Wilder", () => {
    // period 2: TR1 = 4 (gap up), TR2 = 2 -> first ATR = 3; next TR = 2 -> (3 * 1 + 2) / 2 = 2.5
    const out = atr(
      [
        { high: 10, low: 8, close: 9 },
        { high: 13, low: 11, close: 12 },
        { high: 13, low: 11, close: 12 },
        { high: 13, low: 11, close: 12 },
      ],
      2,
    );
    expect(out[2]).toBeCloseTo(3, 10);
    expect(out[3]).toBeCloseTo(2.5, 10);
  });

  it("adx of a steady uptrend: +DI above -DI and ADX at 100", () => {
    const candles = Array.from({ length: 60 }, (_, i) => ({ high: 11 + i, low: 9 + i, close: 10 + i }));
    const r = adx(candles, 14);
    expect(Number.isNaN(r.adx[26]!)).toBe(true);
    expect(r.adx[27]).toBeCloseTo(100, 6);
    expect(r.plusDi[59]!).toBeGreaterThan(r.minusDi[59]!);
    expect(r.minusDi[59]).toBeCloseTo(0, 10);
  });

  it("adx of a steady downtrend: -DI above +DI", () => {
    const candles = Array.from({ length: 60 }, (_, i) => ({ high: 111 - i, low: 109 - i, close: 110 - i }));
    const r = adx(candles, 14);
    expect(r.minusDi[59]!).toBeGreaterThan(r.plusDi[59]!);
  });

  it("bollinger bands of 1..5 with period 5 and k 2", () => {
    const b = bollinger([1, 2, 3, 4, 5], 5, 2);
    expect(b.middle[4]).toBe(3);
    expect(b.upper[4]).toBeCloseTo(3 + 2 * Math.SQRT2, 10);
    expect(b.lower[4]).toBeCloseTo(3 - 2 * Math.SQRT2, 10);
  });

  it("volume SMA and ratio", () => {
    const volumes = [...new Array(19).fill(10), 40]; // the average of the 20 is 11.5
    expect(volumeSma(volumes, 20)[19]).toBeCloseTo(11.5, 10);
    expect(volumeRatio(volumes, 20)[19]).toBeCloseTo(40 / 11.5, 10);
    expect(Number.isNaN(volumeRatio(volumes, 20)[18]!)).toBe(true);
  });
});

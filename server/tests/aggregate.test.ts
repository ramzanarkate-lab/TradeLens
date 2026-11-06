import { describe, expect, it } from "vitest";
import { aggregateCandles } from "../src/market/aggregate.js";
import type { Candle } from "../src/types/index.js";

const HOUR = 3_600_000;
const MIN = 60_000;

/** 1m candles starting at `start`; price follows i so OHLC is easy to predict. */
function minutes(start: number, count: number, closedUpTo = Infinity): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: start + i * MIN,
    open: 100 + i,
    high: 200 + i,
    low: 50 - i,
    close: 101 + i,
    volume: 2,
    closed: i < closedUpTo,
  }));
}

describe("aggregateCandles", () => {
  it("builds one correct 1h candle from 60 one-minute candles", () => {
    const start = 10 * HOUR; // aligned to the hour
    const result = aggregateCandles(minutes(start, 60), "1h");

    expect(result).toEqual([
      { time: start, open: 100, high: 259, low: -9, close: 160, volume: 120, closed: true },
    ]);
  });

  it("splits across buckets, sorts input and ignores duplicates", () => {
    const start = 10 * HOUR;
    const input = minutes(start, 120).reverse();
    input.push(input[0]!); // duplicate minute
    const result = aggregateCandles(input, "1h");
    expect(result.map((c) => c.time)).toEqual([start, start + HOUR]);
    expect(result.map((c) => c.volume)).toEqual([120, 120]);
    expect(result[1]!.open).toBe(100 + 60);
  });

  it("marks a bucket open when it is incomplete or its last minute is still forming", () => {
    const start = 10 * HOUR;
    expect(aggregateCandles(minutes(start, 45), "1h")[0]!.closed).toBe(false);
    expect(aggregateCandles(minutes(start, 60, 59), "1h")[0]!.closed).toBe(false);
  });

  it("builds 15m candles aligned to :00/:15/:30/:45", () => {
    const start = 10 * HOUR + 7 * MIN; // starts mid-bucket
    const result = aggregateCandles(minutes(start, 30), "15m");
    expect(result.map((c) => c.time)).toEqual([10 * HOUR, 10 * HOUR + 15 * MIN, 10 * HOUR + 30 * MIN]);
    expect(result[0]!.closed).toBe(false); // first bucket is missing minutes :00-:06
    expect(result[1]!.closed).toBe(true);
  });

  it("builds 4h and 1d candles", () => {
    const day = 20_000 * 24 * HOUR;
    const full = minutes(day, 24 * 60);
    const fourH = aggregateCandles(full, "4h");
    expect(fourH).toHaveLength(6);
    expect(fourH.every((c) => c.closed)).toBe(true);
    const oneD = aggregateCandles(full, "1d");
    expect(oneD).toHaveLength(1);
    expect(oneD[0]).toMatchObject({ time: day, open: 100, close: 101 + 24 * 60 - 1, volume: 2 * 24 * 60, closed: true });
  });

  it("returns an empty array for no input", () => {
    expect(aggregateCandles([], "1h")).toEqual([]);
  });
});

import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { classicPivots, computePivots } from "../src/analysis/pivots.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { CandleCache } from "../src/market/cache.js";
import { MarketService } from "../src/market/service.js";
import type { Candle } from "../src/types/index.js";

const DAY = 86_400_000;
const day = (n: number, h: number, l: number, c: number, closed = true): Candle => ({
  time: n * DAY,
  open: c,
  high: h,
  low: l,
  close: c,
  volume: 1,
  closed,
});

describe("classic pivots", () => {
  it("matches the formulas for H=110, L=90, C=105 (rounded to 2 decimals)", () => {
    const p = classicPivots(110, 90, 105, 2);
    expect(p.P).toBeCloseTo(101.67, 2); // 101.666...
    expect(p.R1).toBeCloseTo(113.33, 2);
    expect(p.S1).toBeCloseTo(93.33, 2);
    expect(p.R2).toBeCloseTo(121.67, 2);
    expect(p.S2).toBeCloseTo(81.67, 2);
    // R3 = H + 2(P - L) = 110 + 2 * 11.667 = 133.33 ; S3 = L - 2(H - P) = 90 - 2 * 8.333 = 73.33
    expect(p.R3).toBeCloseTo(133.33, 2);
    expect(p.S3).toBeCloseTo(73.33, 2);
  });

  it("is unrounded-exact before rounding", () => {
    const p = classicPivots(110, 90, 105, 10);
    expect(p.P).toBeCloseTo(101.6666666667, 9);
    expect(p.R3).toBeCloseTo(133.3333333333, 9);
  });

  it("uses the previous completed daily candle and ignores the forming one", () => {
    const series = [day(100, 50, 40, 45), day(101, 110, 90, 105), day(102, 999, 1, 500, false)];
    const result = computePivots("BTCUSDT", series)!;
    expect(result).toMatchObject({ symbol: "BTCUSDT", basis: "daily", date: new Date(101 * DAY).toISOString().slice(0, 10) });
    expect(result.P).toBeCloseTo(101.67, 2);
    expect(result.R3).toBeCloseTo(133.33, 2);
  });

  it("works regardless of input order and returns null with no completed candle", () => {
    expect(computePivots("ETHUSDT", [day(102, 110, 90, 105), day(100, 50, 40, 45)])!.date).toBe(new Date(102 * DAY).toISOString().slice(0, 10));
    expect(computePivots("ETHUSDT", [day(102, 110, 90, 105, false)])).toBeNull();
    expect(computePivots("ETHUSDT", [])).toBeNull();
  });

  it("rounds to the symbol's tick size: BTC 2, SOL 3, ETH 2 decimals", () => {
    const series = [day(101, 110.1234, 90.5678, 105.4321)];
    const decimals = (n: number) => (String(n).split(".")[1] ?? "").length;
    for (const [symbol, max] of [["BTCUSDT", 2], ["SOLUSDT", 3], ["ETHUSDT", 2]] as const) {
      const r = computePivots(symbol, series)!;
      for (const v of [r.P, r.R1, r.R2, r.R3, r.S1, r.S2, r.S3]) expect(decimals(v)).toBeLessThanOrEqual(max);
    }
    // (110.1234 + 90.5678 + 105.4321) / 3 = 102.0411
    expect(computePivots("SOLUSDT", series)!.P).toBe(102.041);
    expect(computePivots("BTCUSDT", series)!.P).toBe(102.04);
  });
});

describe("GET /api/pivots", () => {
  const logger = createLogger({ level: "silent", pretty: false });
  const setup = (fetchKlines: ReturnType<typeof vi.fn>) => {
    const market = new MarketService({ rest: { fetchKlines } as never, cache: new CandleCache(), logger });
    return createApp({ env: { CORS_ORIGINS: [] }, logger, clientCount: () => 0, market });
  };

  it("returns pivots from the previous completed daily candle", async () => {
    const fetchKlines = vi.fn(async () => [day(101, 110, 90, 105), day(102, 120, 100, 110, false)]);
    const res = await request(setup(fetchKlines)).get("/api/pivots?symbol=BTCUSDT").expect(200);
    expect(res.body).toMatchObject({ symbol: "BTCUSDT", basis: "daily", P: 101.67, R1: 113.33, S1: 93.33, R2: 121.67, S2: 81.67, R3: 133.33, S3: 73.33 });
    expect(fetchKlines).toHaveBeenCalledWith("BTCUSDT", "1d", 10);
  });

  it("validates the symbol and reports a missing completed candle", async () => {
    await request(setup(vi.fn())).get("/api/pivots?symbol=DOGEUSDT").expect(400);
    const none = vi.fn(async () => [day(102, 120, 100, 110, false)]);
    const res = await request(setup(none)).get("/api/pivots?symbol=ETHUSDT").expect(502);
    expect(res.body.error.code).toBe("NO_COMPLETED_DAILY_CANDLE");
  });
});

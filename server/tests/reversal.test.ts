import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, evaluateAt, prepareContext, type EngineContext } from "../src/signals/engine.v2.js";
import { H4_MS, HOUR_MS, DAY_MS } from "../src/signals/mtf.js";
import { detectPatterns, isEngulfing, isHammer, isPiercing, isStar, isTweezer, ALL_PATTERNS_ON } from "../src/signals/patterns.js";
import { assessReversal, type ReversalConfig, type ReversalInput } from "../src/signals/reversal.js";
import { DEFAULT_SETTINGS, sectionSchemas } from "../src/settings/schema.js";
import type { Candle, PivotLevels } from "../src/types/index.js";

const c = (open: number, high: number, low: number, close: number, volume = 100): Candle => ({ time: 0, open, high, low, close, volume, closed: true });

describe("pattern detectors (fixed candles)", () => {
  it("hammer / shooting star", () => {
    expect(isHammer(c(100, 101.2, 97.5, 101), "bullish")).toBe(true);
    expect(isHammer(c(100, 101.2, 99, 101), "bullish")).toBe(false); // lower wick only 1x the body
    expect(isHammer(c(100, 101.6, 97.5, 101), "bullish")).toBe(false); // upper wick 0.6x the body
    expect(isHammer(c(101, 103.5, 99.8, 100), "bearish")).toBe(true); // shooting star
    expect(isHammer(c(101, 101.9, 99.8, 100), "bearish")).toBe(false);
  });

  it("bullish and bearish engulfing", () => {
    expect(isEngulfing(c(102, 102.5, 99.8, 100), c(99.5, 103, 99.4, 102.5), "bullish")).toBe(true);
    expect(isEngulfing(c(102, 102.5, 99.8, 100), c(99.5, 103, 99.4, 101.9), "bullish")).toBe(false); // close short of the prior open
    expect(isEngulfing(c(100, 102.5, 99.8, 102), c(102.5, 102.8, 99, 99.5), "bearish")).toBe(true);
    expect(isEngulfing(c(100, 102.5, 99.8, 102), c(102.5, 102.8, 99, 100.1), "bearish")).toBe(false);
  });

  it("piercing line / dark cloud cover", () => {
    const prevBear = c(105, 105.5, 99.5, 100);
    expect(isPiercing(prevBear, c(99, 103.5, 98.5, 103), "bullish")).toBe(true);
    expect(isPiercing(prevBear, c(99, 103, 98.5, 102), "bullish")).toBe(false); // closes below the midpoint 102.5
    expect(isPiercing(prevBear, c(99.8, 103.5, 98.5, 103), "bullish")).toBe(false); // does not open below the prior low
    const prevBull = c(100, 105.5, 99.5, 105);
    expect(isPiercing(prevBull, c(106, 106.5, 101.5, 102), "bearish")).toBe(true);
    expect(isPiercing(prevBull, c(106, 106.5, 101.5, 103), "bearish")).toBe(false);
  });

  it("morning star / evening star", () => {
    const big = c(110, 110.5, 99.5, 100);
    const small = c(99, 100, 98.5, 99.5);
    expect(isStar(big, small, c(100, 106.5, 99.8, 106), "bullish")).toBe(true);
    expect(isStar(big, small, c(100, 104.5, 99.8, 104), "bullish")).toBe(false); // does not close above the midpoint 105
    expect(isStar(big, c(99, 104, 95, 103), c(100, 106.5, 99.8, 106), "bullish")).toBe(false); // middle candle is not small
    const bigUp = c(100, 110.5, 99.5, 110);
    const smallUp = c(111, 111.5, 110, 110.5);
    expect(isStar(bigUp, smallUp, c(110, 110.2, 103.5, 104), "bearish")).toBe(true);
    expect(isStar(bigUp, smallUp, c(110, 110.2, 105.5, 106), "bearish")).toBe(false);
  });

  it("tweezer bottom / top need lows (highs) within 0.1 ATR and the right colour", () => {
    expect(isTweezer(c(102, 102.5, 100, 100.5), c(100.2, 103, 100.05, 102.5), 1, "bullish")).toBe(true);
    expect(isTweezer(c(102, 102.5, 100, 100.5), c(100.2, 103, 100.2, 102.5), 1, "bullish")).toBe(false); // lows 0.2 apart
    expect(isTweezer(c(102, 102.5, 100, 100.5), c(102.5, 102.5, 100.05, 100.2), 1, "bullish")).toBe(false); // second candle bearish
    expect(isTweezer(c(100, 105, 99.5, 104.5), c(104.5, 104.95, 101, 101.5), 1, "bearish")).toBe(true);
    expect(isTweezer(c(100, 105, 99.5, 104.5), c(104.5, 104.7, 101, 101.5), 1, "bearish")).toBe(false);
  });

  it("detectPatterns reports the pattern's extreme and honours the per-pattern switches", () => {
    const candles = [c(100, 100.5, 99, 99.5), c(100, 101.2, 97.5, 101)];
    const hits = detectPatterns(candles, 1, 2);
    expect(hits.some((h) => h.key === "hammer" && h.direction === "bullish" && h.extreme === 97.5)).toBe(true);
    expect(detectPatterns(candles, 1, 2, { ...ALL_PATTERNS_ON, hammer: false }).some((h) => h.key === "hammer")).toBe(false);
  });
});

describe("key level filter and scoring", () => {
  const pivots: PivotLevels = { P: 110, R1: 120, R2: 130, R3: 140, S1: 97.6, S2: 90, S3: 80 };
  const cfg: ReversalConfig = { enabled: true, minVolumeRatio: 1.2, levelToleranceAtr: 0.5, patterns: ALL_PATTERNS_ON };
  const flat = Array.from({ length: 25 }, () => c(120, 121, 119, 120));
  const only = (hammerLow: number, volRatio: number, direction: "hammer" | "star" = "hammer"): ReversalInput => {
    const candle = direction === "hammer" ? c(100, 101.2, hammerLow, 101) : c(101, 103.5 + (hammerLow - 97.5), 99.8, 100);
    return { label: "1H", candles: [...flat, candle], i: flat.length, atr: 2, ema50: 999, ema200: 999, volRatio };
  };

  it("a hammer at S1 in the BUY direction adds 10 points, 15 with volume, and the reason names the level", () => {
    const plain = assessReversal("BUY", [only(97.5, 1.0)], pivots, cfg);
    expect(plain.points).toBe(10);
    expect(plain.reasons).toEqual(["Hammer at S1"]);
    const confirmed = assessReversal("BUY", [only(97.5, 1.4)], pivots, cfg);
    expect(confirmed.points).toBe(15);
    expect(confirmed.reasons).toEqual(["Hammer at S1 with volume 1.4× average"]);
  });

  it("the same hammer away from any level scores 0 and blocks nothing", () => {
    const away = assessReversal("BUY", [only(97.5, 2)], { ...pivots, S1: 60, S2: 50, S3: 40 }, cfg);
    expect(away).toEqual({ points: 0, reasons: [], veto: null });
    // right at the edge: 0.5 ATR = 1.0 away is a level, 1.01 away is not
    expect(assessReversal("BUY", [only(97.5, 1)], { ...pivots, S1: 98.5 }, cfg).points).toBe(10);
    expect(assessReversal("BUY", [only(97.5, 1)], { ...pivots, S1: 98.51 }, cfg).points).toBe(0);
  });

  it("EMA50, EMA200 and the 20-candle swing low are key levels too", () => {
    const far: PivotLevels = { ...pivots, S1: 1, S2: 1, S3: 1 };
    expect(assessReversal("BUY", [{ ...only(97.5, 1), ema50: 97.8 }], far, cfg).reasons).toEqual(["Hammer at EMA50"]);
    expect(assessReversal("BUY", [{ ...only(97.5, 1), ema200: 97.2 }], far, cfg).reasons).toEqual(["Hammer at EMA200"]);
    const swing = [...Array.from({ length: 25 }, () => c(120, 121, 97.3, 120)), c(100, 101.2, 97.5, 101)];
    expect(assessReversal("BUY", [{ ...only(97.5, 1), candles: swing }], far, cfg).reasons).toEqual(["Hammer at the 20-candle swing low"]);
  });

  it("a pattern against the signal direction at a key level is a veto", () => {
    const r = assessReversal("SELL", [only(97.5, 1.4)], pivots, cfg); // a bullish hammer at S1 against a SELL
    expect(r.veto).toBe("veto: Hammer at S1 against this SELL");
    expect(r.points).toBe(0);
  });

  it("turning a pattern off removes its points", () => {
    const off = assessReversal("BUY", [only(97.5, 1.4)], pivots, { ...cfg, patterns: { ...ALL_PATTERNS_ON, hammer: false } });
    expect(off.points).toBe(0);
    expect(assessReversal("BUY", [only(97.5, 1.4)], pivots, { ...cfg, enabled: false })).toEqual({ points: 0, reasons: [], veto: null });
  });

  it("settings: defaults are on with 1.2 and 0.5, and bad ranges are rejected", () => {
    expect(DEFAULT_SETTINGS.signals).toMatchObject({ reversalEnabled: true, reversalMinVolumeRatio: 1.2, reversalLevelToleranceAtr: 0.5 });
    expect(sectionSchemas.signals.safeParse(DEFAULT_SETTINGS.signals).success).toBe(true);
    expect(sectionSchemas.signals.safeParse({ ...DEFAULT_SETTINGS.signals, reversalMinVolumeRatio: 0 }).success).toBe(false);
    expect(sectionSchemas.signals.safeParse({ ...DEFAULT_SETTINGS.signals, reversalLevelToleranceAtr: 9 }).success).toBe(false);
    expect(sectionSchemas.signals.safeParse({ ...DEFAULT_SETTINGS.signals, reversalEnabled: "yes" }).success).toBe(false);
  });
});

describe("reversal in the engine", () => {
  function series() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const h1: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 280 * 24; i++) {
      const open = price;
      price = open * (1 + 0.0004 + (rnd() - 0.5) * 0.01);
      h1.push({ time: i * HOUR_MS, open, high: Math.max(open, price) * 1.002, low: Math.min(open, price) * 0.998, close: price, volume: 100 + rnd() * 100, closed: true });
    }
    const regroup = (size: number) => {
      const per = size / HOUR_MS;
      const out: Candle[] = [];
      for (let k = 0; k + per <= h1.length; k += per) {
        const g = h1.slice(k, k + per);
        out.push({ time: g[0]!.time, open: g[0]!.open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[per - 1]!.close, volume: g.reduce((s, x) => s + x.volume, 0), closed: true });
      }
      return out;
    };
    return { h1, h4: regroup(H4_MS), d1: regroup(DAY_MS) };
  }

  const base = { ...DEFAULT_ENGINE_CONFIG, minScore: 0, minRiskPercent: 0, maxRiskPercent: 100 };
  const ctx0 = prepareContext("BTCUSDT", series());
  const up: EngineContext = { ...ctx0, ema200d: ctx0.ema200d.map(() => 1e-12), volRatio1: ctx0.volRatio1.map(() => 2) };
  const first = Array.from({ length: up.series.h1.length }, (_, i) => evaluateAt(up, i, { config: base, hasOpen: () => false })).findIndex((o) => o.signal);
  const withCandle = (candle: Candle): EngineContext => ({ ...up, series: { ...up.series, h1: up.series.h1.map((x, i) => (i === first ? { ...candle, time: x.time } : x)) } });
  const orig = up.series.h1[first]!;
  // a hammer / shooting star that keeps the original close, so every other number stays the same
  const hammer = c(orig.close - 1, orig.close + 0.1, orig.close - 3, orig.close);
  const star = c(orig.close + 1, orig.close + 3, orig.close - 0.1, orig.close);
  // "at a key level" is made easy here (huge tolerance); the level logic itself is tested above
  const reversal = (over: Partial<ReversalConfig> = {}): ReversalConfig => ({ enabled: true, minVolumeRatio: 1.2, levelToleranceAtr: 1e6, patterns: { hammer: true, engulfing: false, piercing: false, morningStar: false, tweezer: false }, ...over });
  const run = (ctx: EngineContext, rev?: ReversalConfig) => evaluateAt(ctx, first, { config: { ...base, ...(rev ? { reversal: rev } : {}) }, hasOpen: () => false });

  it("the fixture produces a BUY to start from", () => {
    expect(first).toBeGreaterThan(0);
    expect(run(up).signal?.side).toBe("BUY");
  });

  it("a hammer at a level adds points and its name appears in the signal reasons", () => {
    const ctx = withCandle(hammer);
    const without = run(ctx).signal!;
    const withIt = run(ctx, reversal()).signal!;
    expect(withIt.score).toBe(Math.min(100, without.score! + 15));
    expect(withIt.reasons!.some((r) => /^Hammer at .* with volume 2\.0× average$/.test(r))).toBe(true);
    expect(withIt.reason).toContain("Hammer at");
  });

  it("turning the pattern off removes its points and reason", () => {
    const ctx = withCandle(hammer);
    const without = run(ctx).signal!;
    const off = run(ctx, reversal({ patterns: { hammer: false, engulfing: false, piercing: false, morningStar: false, tweezer: false } })).signal!;
    expect(off.score).toBe(without.score);
    expect(off.reasons!.some((r) => r.startsWith("Hammer"))).toBe(false);
  });

  it("a hammer away from every level scores nothing", () => {
    const ctx = withCandle(hammer);
    const away = run(ctx, reversal({ levelToleranceAtr: 1e-9 })).signal!;
    expect(away.score).toBe(run(ctx).signal!.score);
  });

  it("a shooting star against a BUY blocks the signal", () => {
    const out = run(withCandle(star), reversal());
    expect(out.signal).toBeNull();
    expect(out).toMatchObject({ reason: expect.stringMatching(/^veto: Shooting star at .* against this BUY$/) });
  });

  it("patterns never create a signal alone: with a score too low the signal stays blocked", () => {
    const ctx = withCandle(hammer);
    const out = evaluateAt(ctx, first, { config: { ...base, minScore: 101, reversal: reversal() }, hasOpen: () => false });
    expect(out.signal).toBeNull(); // 100 is the cap, so even +15 cannot reach 101
  });

  it("the total score never exceeds 100", () => {
    const s = run(withCandle(hammer), reversal()).signal!;
    expect(s.score!).toBeLessThanOrEqual(100);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DemoRest } from "../src/demo/demoRest.js";
import { writeSeed } from "../src/demo/seedData.js";

const root = mkdtempSync(join(tmpdir(), "tradelens-seed-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 5, 10, 12, 7, 0);

describe("offline demo data", () => {
  const seeded = writeSeed(root, NOW);

  it("writes only inside <root>/data/demo", () => {
    expect(seeded.dir).toBe(join(root, "data", "demo"));
    expect(seeded.candleFile.startsWith(seeded.dir)).toBe(true);
    expect(seeded.signalFile.startsWith(seeded.dir)).toBe(true);
  });

  it("creates signals from the multi-indicator engine, with entry, stop and three targets", () => {
    expect(seeded.signalCount).toBeGreaterThan(0);
    const signals = JSON.parse(readFileSync(seeded.signalFile, "utf8")) as Array<Record<string, unknown>>;
    for (const s of signals) {
      expect(s).toMatchObject({ mode: "paper", trigger: "multi_indicator" });
      for (const key of ["entry", "sl", "tp1", "tp2", "tp3", "score", "riskPercent"]) expect(typeof s[key]).toBe("number");
      expect(Array.isArray(s.reasons)).toBe(true);
    }
  });

  it("serves candles and a price for every symbol without any network call", async () => {
    const rest = new DemoRest(seeded.candleFile, () => NOW);
    for (const symbol of ["BTCUSDT", "SOLUSDT", "ETHUSDT"]) {
      const candles = await rest.fetchKlines(symbol, "1h", 100);
      expect(candles).toHaveLength(100);
      expect(candles.every((c) => c.high >= c.low)).toBe(true);
      expect((await rest.fetchTicker24h(symbol)).price).toBeGreaterThan(0);
    }
  });

  it("shifts old sample data forward so the newest candle is recent", async () => {
    const later = NOW + 5 * 86_400_000;
    const rest = new DemoRest(seeded.candleFile, () => later);
    const candles = await rest.fetchKlines("BTCUSDT", "15m", 5);
    expect(later - candles[candles.length - 1]!.time).toBeLessThan(2 * 86_400_000);
  });

  it("tells you to run the seed when the file is missing", () => {
    expect(() => new DemoRest(join(root, "nope.json"))).toThrow(/npm run seed/);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { StrategyBacktestStore } from "../src/strategies/backtestStore.js";
import { StrategySignalStore, type StrategySignal } from "../src/strategies/signalStore.js";

const silent = createLogger({ level: "silent", pretty: false });
const auth = new AuthService({ secret: "unit-test-secret-at-least-16-chars", adminIds: () => ["admin-1"] });
const bearer = (id: string) => ({ Authorization: `Bearer ${auth.issue({ id, email: `${id}@x.test`, name: id }).token}` });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-strat-routes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const part = (trades: number, expectancyR: number | null) => ({ trades, expectancyR, profitFactor: 0.8, maxDrawdownR: 12.3, maxDrawdownPercent: 11.1, winRate: 40, equityReturnPercent: -5 });
const signal = (id: string, over: Partial<StrategySignal> = {}): StrategySignal => ({
  id, strategyId: "UnusualVolumeGainers", symbol: "BTCUSDT", timeframe: "1h", direction: "BUY", entry: 100, stopLoss: 99, targets: [103], tp1: 103, tp2: 103, tp3: 103,
  createdAt: 1_000, candleTime: 0, lastCheckedCandle: 0, validated: false, researchOnly: true, status: "CLOSED",
  outcome: { reason: "SL", exitPrice: 99, closedAt: 2_000, returnPercent: -1, netR: -1.3 }, ...over,
});

function build() {
  const file = join(dir, "bt.json");
  writeFileSync(
    file,
    JSON.stringify({
      generatedAt: "2026-11-07T00:00:00.000Z",
      months: 60,
      thresholds: { minProfitFactor: 1.3, minTrades: 30, maxDrawdownR: 10 },
      note: "n",
      rows: [{ strategyId: "UnusualVolumeGainers", symbol: "BTCUSDT", timeframe: "1h", from: "a", to: "b", splitAt: "c", inSample: part(300, -0.28), outOfSample: part(120, -0.31), status: "NOT PASSED", checks: [] }],
    }),
  );
  const signals = new StrategySignalStore(join(dir, "signals.json"), silent);
  signals.add(signal("a"));
  signals.add(signal("b", { strategyId: "EmaCrossover12_50", validated: true, researchOnly: false, status: "OPEN", outcome: undefined }));
  const app = createApp({ env: { CORS_ORIGINS: [] }, logger: silent, clientCount: () => 0, auth, strategies: { backtests: new StrategyBacktestStore(file), signals } });
  return app;
}

describe("admin view of the strategy library", () => {
  it("is admin only", async () => {
    const app = build();
    for (const url of ["/api/admin/strategies", "/api/admin/strategy-signals"]) {
      await request(app).get(url).expect(401);
      await request(app).get(url).set(bearer("u1")).expect(403);
      await request(app).get(url).set(bearer("admin-1")).expect(200);
    }
  });

  it("lists strategy, symbol, timeframe, in-sample and out-of-sample expectancy, out-of-sample trades, drawdown and status", async () => {
    const res = await request(build()).get("/api/admin/strategies").set(bearer("admin-1")).expect(200);
    expect(res.body.rows[0]).toMatchObject({
      strategyId: "UnusualVolumeGainers",
      symbol: "BTCUSDT",
      timeframe: "1h",
      inSampleExpectancyR: -0.28,
      outOfSampleExpectancyR: -0.31,
      outOfSampleTrades: 120,
      maxDrawdownR: 12.3,
      status: "NOT PASSED",
    });
    expect(res.body.strategies).toHaveLength(12);
  });

  it("says so when no backtest has been run: nothing has passed", async () => {
    const app = createApp({ env: { CORS_ORIGINS: [] }, logger: silent, clientCount: () => 0, auth, strategies: { backtests: new StrategyBacktestStore(join(dir, "none.json")), signals: new StrategySignalStore(join(dir, "s.json"), silent) } });
    const res = await request(app).get("/api/admin/strategies").set(bearer("admin-1")).expect(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.note).toContain("research only");
  });

  it("shows every signal of every strategy, losses included, with its outcome and whether it is research only", async () => {
    const res = await request(build()).get("/api/admin/strategy-signals").set(bearer("admin-1")).expect(200);
    expect(res.body.total).toBe(2);
    const loss = res.body.signals.find((s: { id: string }) => s.id === "a");
    expect(loss).toMatchObject({ researchOnly: true, validated: false, status: "CLOSED", outcome: { reason: "SL", netR: -1.3 } });
    const open = res.body.signals.find((s: { id: string }) => s.id === "b");
    expect(open).toMatchObject({ researchOnly: false, validated: true, status: "OPEN", outcome: null });
    expect((await request(build()).get("/api/admin/strategy-signals?strategyId=EmaCrossover12_50").set(bearer("admin-1")).expect(200)).body.total).toBe(1);
  });
});

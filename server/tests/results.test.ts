import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import { SignalStore } from "../src/signals/store.js";
import type { Signal } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 15); // 15 Oct 2026

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-results-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function signal(i: number, symbol: Signal["symbol"], status: Signal["status"], resultR: number | null, over: Partial<Signal> = {}): Signal {
  const closed = status !== "OPEN";
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    symbol,
    side: "BUY",
    timeframe: "1h",
    price: 100,
    levels: { S1: 90, R2: 120, pivots: { P: 100, R1: 110, R2: 120, R3: 130, S1: 90, S2: 80, S3: 70 } },
    indicators: { emaFast: 1, emaSlow: 2, rsi: 50 },
    trigger: "multi_indicator",
    reason: "t",
    createdAt: T + i * DAY,
    mode: "paper",
    score: 80,
    entry: 100,
    sl: 98,
    status,
    statusHistory: [
      { status: "OPEN", at: T + i * DAY, price: 100, resultR: null },
      ...(status === "TP1_HIT" || status === "TP2_HIT" || status === "TP3_HIT" ? [{ status: "TP1_HIT" as const, at: T + i * DAY + 1000, price: 102, resultR: 1 }] : []),
    ],
    closedAt: closed ? T + i * DAY + 3_600_000 : null,
    resultR,
    ...over,
  } as Signal;
}

async function build() {
  const store = new SignalStore(join(dir, "signals.json"), silent);
  store.load();
  await store.add(signal(1, "BTCUSDT", "TP3_HIT", 3));
  await store.add(signal(2, "BTCUSDT", "SL_HIT", -1));
  await store.add(signal(3, "ETHUSDT", "TP3_HIT", 3));
  await store.add(signal(4, "BTCUSDT", "OPEN", null)); // still running: not a result yet
  await store.add(signal(5, "SOLUSDT", "TP1_HIT", 1, { test: true })); // a test alert: never counted

  const backtestDir = join(dir, "backtests");
  mkdirSync(backtestDir);
  const trades = Array.from({ length: 12 }, (_, i) => ({
    createdAt: new Date(T - (i + 1) * DAY).toISOString(),
    side: i % 2 ? "SELL" : "BUY",
    score: 75,
    entry: 100,
    sl: 98,
    ...(i === 0 ? { tp1: 102, tp2: 104, tp3: 106 } : {}),
    exitStatus: i % 3 ? "SL_HIT" : "TP2_HIT",
    exitPrice: 98,
    grossR: 0,
    netR: i % 3 ? -1.1 : 1.9,
    part: i < 4 ? "out-of-sample" : "in-sample",
  }));
  writeFileSync(
    join(backtestDir, "BTCUSDT-2026-11-06.json"),
    JSON.stringify({
      symbol: "BTCUSDT",
      months: 12,
      range: { from: "2025-11-06T00:00:00.000Z", to: "2026-11-06T00:00:00.000Z", splitAt: "2026-07-20T00:00:00.000Z" },
      engine: { minScore: 70, stopBufferAtr: 1.5, timeframe: "4h" },
      inSample: { trades: 8, winRate: 40, profitFactor: 0.5 },
      outOfSample: { trades: 4, winRate: 50, profitFactor: 0.9 },
      verdict: "FAIL",
      trades,
    }),
  );

  const auth = new AuthService({ secret: "a-long-enough-test-secret", adminIds: () => [] });
  const token = auth.issue({ id: "u", email: "u@x.test", name: "U", emailVerified: true }).token;
  const app = createApp({ env: { CORS_ORIGINS: [] }, logger: silent, clientCount: () => 0, auth, signals: store, backtestDir, rateLimit: { limit: 1000 } });
  return { app, bearer: { Authorization: `Bearer ${token}` } };
}

describe("GET /api/results", () => {
  it("counts only finished, non-test signals and breaks them down by symbol and month", async () => {
    const { app, bearer } = await build();
    const { body } = await request(app).get("/api/results").set(bearer).expect(200);
    expect(body.live.overall).toMatchObject({ closed: 3, wins: 2, winRate: 66.7 }); // the open signal and the test signal are not results
    expect(body.live.totalR).toBe(5);
    const btc = body.live.bySymbol.find((s: { symbol: string }) => s.symbol === "BTCUSDT");
    expect(btc).toMatchObject({ closed: 2, wins: 1, winRate: 50, totalR: 2, avgR: 1 });
    expect(body.live.bySymbol.find((s: { symbol: string }) => s.symbol === "SOLUSDT")).toMatchObject({ closed: 0, winRate: null });
    expect(body.live.byMonth.reduce((n: number, m: { closed: number }) => n + m.closed, 0)).toBe(3);
    expect(body.live.recent).toHaveLength(3);
    expect(body.live.recent[0].resultR).toBe(3);
    expect(body.live.recent[0]).toMatchObject({ entry: 100, sl: 98, exitPrice: 102 }); // the history shows entry, stop and where it exited // newest closed first (signal 3)
  });

  it("includes the saved backtest: what the technique did on past charts, newest trade first, with its settings", async () => {
    const { app, bearer } = await build();
    const { body } = await request(app).get("/api/results").set(bearer).expect(200);
    expect(body.backtest).toHaveLength(1);
    const bt = body.backtest[0];
    expect(bt).toMatchObject({ symbol: "BTCUSDT", verdict: "FAIL", months: 12, timeframe: "4h", stopBufferAtr: 1.5, tradesTotal: 12 });
    expect(bt.inSample).toMatchObject({ trades: 8 });
    expect(bt.trades).toHaveLength(12);
    expect(bt.trades[0].createdAt > bt.trades[1].createdAt).toBe(true);
    // every trade carries entry, stop, targets and the exit price (targets are null in reports saved before they were recorded)
    expect(bt.trades[0]).toMatchObject({ entry: 100, sl: 98, tp1: 102, tp2: 104, tp3: 106, exitPrice: 98, exitStatus: "TP2_HIT" });
    expect(bt.trades[1]).toMatchObject({ entry: 100, sl: 98, tp1: null, exitPrice: 98 });
    // win rate over the whole period: (8 x 40% + 4 x 50%) / 12 trades
    expect(bt.overall).toMatchObject({ trades: 12, winRate: 43.3 });
  });

  it("guests see the numbers and only the newest 5 trades, and are told the rest is locked", async () => {
    const { app } = await build();
    const { body } = await request(app).get("/api/results").expect(200);
    expect(body).toMatchObject({ role: "guest", cap: 5, locked: true });
    expect(body.live.overall.closed).toBe(3);
    expect(body.backtest[0].trades).toHaveLength(5);
    expect(body.backtest[0].tradesTotal).toBe(12);
  });

  it("can be limited to one symbol, and rejects an unknown one", async () => {
    const { app, bearer } = await build();
    const one = await request(app).get("/api/results?symbol=ETHUSDT").set(bearer).expect(200);
    expect(one.body.live.overall.closed).toBe(1);
    expect(one.body.backtest).toEqual([]); // no ETH backtest yet
    await request(app).get("/api/results?symbol=DOGEUSDT").set(bearer).expect(400);
  });

  it("works with nothing in it yet", async () => {
    const store = new SignalStore(join(dir, "empty.json"), silent);
    store.load();
    const app = createApp({ env: { CORS_ORIGINS: [] }, logger: silent, clientCount: () => 0, signals: store, backtestDir: join(dir, "none"), rateLimit: { limit: 1000 } });
    const { body } = await request(app).get("/api/results").expect(200);
    expect(body.live.overall.closed).toBe(0);
    expect(body.live.recent).toEqual([]);
    expect(body.backtest).toEqual([]);
  });
});

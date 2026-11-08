import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.js";
import { DemoTrader, REFILL_COOLDOWN_MS, START_BALANCE } from "../src/demotrade/demoTrader.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logging/logger.js";
import type { Signal } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-demo-"));
  file = join(dir, "demo.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** A SELL at 100: stop 102, targets 98 / 96 / 94. */
function sell(id = "s1", over: Partial<Signal> = {}): Signal {
  return {
    id,
    symbol: "ETHUSDT",
    side: "SELL",
    timeframe: "15m",
    price: 100,
    levels: { S1: 90, R2: 110, pivots: { P: 100, R1: 105, R2: 110, R3: 115, S1: 90, S2: 85, S3: 80 } },
    indicators: { emaFast: 1, emaSlow: 2, rsi: 50 },
    trigger: "multi_indicator",
    reason: "t",
    createdAt: 1_000,
    mode: "paper",
    entry: 100,
    sl: 102,
    tp1: 98,
    tp2: 96,
    tp3: 94,
    status: "OPEN",
    statusHistory: [{ status: "OPEN", at: 1_000, price: 100, resultR: null }],
    closedAt: null,
    resultR: null,
    ...over,
  } as Signal;
}

const bar = (high: number, low: number, at = 5_000) => ({ high, low, close: (high + low) / 2, at });

/** A trader with one user ("u1") who already trades one signal. Fees are off unless a test needs them. */
function setup(opts: { now?: () => number; fee?: number; active?: Signal[] } = {}) {
  const t = new DemoTrader({ file, logger: silent, now: opts.now ?? (() => 1_000), activeSignals: () => opts.active ?? [sell()] });
  t.updateSettings({ feePercent: opts.fee ?? 0 });
  t.view("u1"); // an account exists from the first time its user opens the app
  return t;
}
const trade = (t: DemoTrader, user = "u1", id = "s1") => [...t.view(user).open, ...t.view(user).closed].find((x) => x.id === id)!;

describe("DemoTrader: account", () => {
  it("starts every user with 10000 USDT and trades the running signals automatically", () => {
    const t = setup();
    const v = t.view("u1");
    expect(v.summary).toMatchObject({ balance: START_BALANCE, tradeSizeUsd: 1000, openCount: 1, closedCount: 0, openPnl: 0, closedPnl: 0 });
    expect(v.open[0]).toMatchObject({ id: "s1", qty: 10, notional: 1000 });
    expect(v.open[0]!.events.map((e) => e.level)).toEqual(["OPEN"]);
  });

  it("each user has a separate account: a new signal opens for everyone, a refill or loss touches only one", () => {
    const t = setup({ active: [] });
    t.view("a");
    t.view("b");
    t.onSignal(sell());
    t.onBar("ETHUSDT", bar(103, 100)); // the stop is hit for both
    expect(t.view("a").summary.balance).toBe(9_980);
    expect(t.view("b").summary.balance).toBe(9_980);
    expect(t.refill("a").ok).toBe(true);
    expect(t.view("a").summary.balance).toBe(START_BALANCE);
    expect(t.view("b").summary.balance).toBe(9_980);
  });

  it("does not trade the same signal twice, test signals or closed signals, or when switched off", () => {
    const t = setup({ active: [] });
    t.view("u1");
    t.onSignal(sell());
    t.onSignal(sell());
    t.onSignal(sell("t", { test: true }));
    t.onSignal(sell("c", { status: "SL_HIT", closedAt: 5 }));
    expect(t.view("u1").summary.openCount).toBe(1);
    t.updateSettings({ enabled: false });
    t.onSignal(sell("off"));
    expect(t.view("u1").summary.openCount).toBe(1);
  });

  it("will not open a trade the free balance cannot cover", () => {
    const t = setup({ active: [] });
    t.updateSettings({ tradeSizeUsd: 6_000 });
    t.view("u1");
    t.onSignal(sell("a"));
    t.onSignal(sell("b")); // only 4000 USDT left
    expect(t.view("u1").summary.openCount).toBe(1);
  });

  it("survives a restart", () => {
    setup().view("u1");
    const again = new DemoTrader({ file, logger: silent });
    expect(again.view("u1").summary.openCount).toBe(1);
    expect(again.view("u1").open[0]!.events).toHaveLength(1);
  });
});

describe("DemoTrader: TP1 / TP2 / TP3 / stop", () => {
  it("TP1 closes 25% and moves the stop to the entry; the next stop then closes the rest as a partial win", () => {
    const t = setup();
    t.onBar("ETHUSDT", bar(99, 98)); // TP1 (98)
    let x = trade(t);
    expect(x).toMatchObject({ stage: 1, sl: 100, qtyLeft: 7.5, state: "OPEN" });
    expect(x.levelStatus.map((l) => l.status)).toEqual(["TP1 Hit", "Pending", "Pending", "Pending"]);
    expect(t.view("u1").summary.balance).toBe(10_005); // 2.5 coins x 2

    t.onBar("ETHUSDT", bar(100.5, 99)); // back to the entry: stopped at 100
    x = trade(t);
    expect(x).toMatchObject({ state: "CLOSED", result: "PARTIAL_WIN", realizedPnl: 5 });
    expect(x.events.map((e) => [e.level, e.closedPercent, e.pnl])).toEqual([["OPEN", 0, 0], ["TP1", 25, 5], ["SL", 75, 0]]);
    expect(x.levelStatus.at(-1)!.status).toBe("SL Hit");
  });

  it("TP2 closes another 25% and moves the stop to TP1; a stop there closes the rest at TP1", () => {
    const t = setup();
    t.onBar("ETHUSDT", bar(99, 98)); // TP1
    t.onBar("ETHUSDT", bar(97, 96)); // TP2
    expect(trade(t)).toMatchObject({ stage: 2, sl: 98, qtyLeft: 5 });
    expect(t.view("u1").summary.balance).toBe(10_015); // +5 and +10
    t.onBar("ETHUSDT", bar(98.5, 97)); // up to TP1 (98): stopped there
    const x = trade(t);
    expect(x).toMatchObject({ state: "CLOSED", result: "PARTIAL_WIN", realizedPnl: 25 }); // +5 +10 +10
    expect(x.events.at(-1)).toMatchObject({ level: "SL", price: 98, closedPercent: 50, pnl: 10 });
  });

  it("TP3 closes the remaining 50%: the trade is a full win", () => {
    const t = setup();
    t.onBar("ETHUSDT", bar(99, 98)); // TP1
    t.onBar("ETHUSDT", bar(97, 96)); // TP2
    t.onBar("ETHUSDT", bar(95, 94)); // TP3
    const x = trade(t);
    expect(x).toMatchObject({ state: "CLOSED", result: "WIN", realizedPnl: 45, stage: 3 });
    expect(x.events.map((e) => [e.level, e.closedPercent, e.pnl])).toEqual([["OPEN", 0, 0], ["TP1", 25, 5], ["TP2", 25, 10], ["TP3", 50, 30]]);
    expect(x.levelStatus.map((l) => l.status)).toEqual(["TP1 Hit", "TP2 Hit", "TP3 Hit", "Pending"]);
    expect(t.view("u1").summary).toMatchObject({ balance: 10_045, closedPnl: 45, wins: 1, losses: 0, winRate: 100 });
  });

  it("the stop at any stage closes what is left; before TP1 it is a loss", () => {
    const t = setup();
    t.onBar("ETHUSDT", bar(102, 100));
    expect(trade(t)).toMatchObject({ state: "CLOSED", result: "LOSS", realizedPnl: -20 });
    expect(t.view("u1").summary).toMatchObject({ balance: 9_980, losses: 1 });
  });

  it("when one bar touches the stop and a target, the stop counts first", () => {
    const t = setup();
    t.onBar("ETHUSDT", bar(102.5, 97));
    expect(trade(t)).toMatchObject({ result: "LOSS", realizedPnl: -20 });
  });

  it("applies each candle once, and ignores candles from before the trade", () => {
    const t = setup({ now: () => 10_000 });
    t.onBar("ETHUSDT", { ...bar(99, 98, 9_000), candleTime: 5_000 }); // opened before the trade
    expect(trade(t).stage).toBe(0);
    t.onBar("ETHUSDT", { ...bar(99, 98, 20_000), candleTime: 15_000 });
    expect(trade(t).stage).toBe(1);
    t.onBar("ETHUSDT", { ...bar(99, 96, 20_000), candleTime: 15_000 }); // the same candle again
    expect(trade(t).stage).toBe(1);
  });

  it("charges fees on every part that closes", () => {
    const t = setup({ fee: 0.04 });
    t.onBar("ETHUSDT", bar(102, 100)); // loss of 20 plus fees of 1000 x 0.04% x 2
    expect(trade(t).realizedPnl).toBe(-20.8);
  });

  it("closes a trade still open when its signal ends on the time limit", () => {
    const t = setup();
    t.onUpdate(sell("s1", { status: "TIME_EXIT", closedAt: 9_000, statusHistory: [{ status: "TIME_EXIT", at: 9_000, price: 99, resultR: 0.5 }] }));
    expect(trade(t)).toMatchObject({ state: "CLOSED", realizedPnl: 10 });
    expect(trade(t).events.at(-1)!.level).toBe("TIME");
  });

  it("reports every event to listeners, and a throwing listener changes nothing", () => {
    const t = setup();
    const seen: string[] = [];
    t.onEvent(() => {
      throw new Error("boom");
    });
    t.onEvent((_u, _trade, e) => seen.push(e.level));
    t.onBar("ETHUSDT", bar(99, 98));
    t.onBar("ETHUSDT", bar(97, 96));
    t.onBar("ETHUSDT", bar(95, 94));
    expect(seen).toEqual(["TP1", "TP2", "TP3"]);
    expect(trade(t).state).toBe("CLOSED");
  });
});

describe("DemoTrader: refill once every 24 hours", () => {
  it("resets the balance to 10000, then tells how long is left", () => {
    let now = 1_000;
    const t = setup({ now: () => now });
    t.onBar("ETHUSDT", bar(102, 100)); // -20
    expect(t.view("u1").summary.balance).toBe(9_980);
    expect(t.refill("u1")).toEqual({ ok: true, balance: START_BALANCE });
    expect(t.view("u1").summary.balance).toBe(START_BALANCE);

    now += 2 * 3_600_000; // two hours later
    const early = t.refill("u1");
    expect(early).toEqual({ ok: false, secondsLeft: 22 * 3_600 });
    expect(t.view("u1").summary.refill).toEqual({ available: false, secondsLeft: 22 * 3_600 });

    now += REFILL_COOLDOWN_MS;
    expect(t.refill("u1").ok).toBe(true);
  });
});

describe("GET /api/demo and POST /api/demo/refill", () => {
  const auth = new AuthService({ secret: "unit-test-secret-at-least-16-chars", adminIds: () => ["admin-1"] });
  const bearer = (id: string) => ({ Authorization: `Bearer ${auth.issue({ id, email: `${id}@x.test`, name: id }).token}` });
  const app = (t: DemoTrader) => createApp({ env: { CORS_ORIGINS: [] }, logger: silent, clientCount: () => 0, auth, demo: t });

  it("needs a sign-in and gives each user their own account", async () => {
    const t = setup();
    const a = app(t);
    await request(a).get("/api/demo").expect(401);
    await request(a).post("/api/demo/refill").expect(401);
    const res = await request(a).get("/api/demo").set(bearer("u1")).expect(200);
    expect(res.body.summary.balance).toBe(START_BALANCE);
    expect(res.body.open[0].levelStatus.map((l: { name: string; percentFromEntry: number }) => [l.name, l.percentFromEntry])).toEqual([["TP1", 2], ["TP2", 4], ["TP3", 6], ["SL", -2]]);
  });

  it("a second refill inside 24 hours is refused with the time left", async () => {
    const t = setup();
    const a = app(t);
    await request(a).post("/api/demo/refill").set(bearer("u1")).expect(200);
    const res = await request(a).post("/api/demo/refill").set(bearer("u1")).expect(429);
    expect(res.body.error.code).toBe("REFILL_TOO_SOON");
    expect(res.body.error.message).toMatch(/\d+h \d+m|\d+m/);
  });

  it("only an admin can change the demo settings", async () => {
    const t = setup();
    const a = app(t);
    await request(a).put("/api/demo/settings").set(bearer("u1")).send({ tradeSizeUsd: 500 }).expect(403);
    await request(a).put("/api/demo/settings").set(bearer("admin-1")).send({ tradeSizeUsd: 500 }).expect(200);
    expect(t.settings().tradeSizeUsd).toBe(500);
    await request(a).put("/api/demo/settings").set(bearer("admin-1")).send({ tradeSizeUsd: -1 }).expect(400);
  });
});

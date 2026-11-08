import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_ACCOUNT, DemoTrader } from "../src/demotrade/demoTrader.js";
import { createLogger } from "../src/logging/logger.js";
import { MAX_RETRIES, messages, TelegramNotifier } from "../src/telegram/telegramNotifier.js";
import { announceTradeEvent } from "../src/telegram/tradeEvents.js";
import type { Signal } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
const TZ = "Asia/Riyadh"; // UTC+3
/** 2026-11-07 HH:mm in UTC+3, as epoch milliseconds. */
const at = (h: number, m: number) => Date.UTC(2026, 10, 7, h - 3, m);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-notifier-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// ---------------------------------------------------------------------------------------------------------------------
// The seven message formats
// ---------------------------------------------------------------------------------------------------------------------
describe("message formats", () => {
  const btcBuy = {
    id: "sig-1",
    symbol: "BTCUSDT",
    side: "BUY",
    timeframe: "15m",
    price: 64_250,
    levels: { S1: 1, R2: 2, pivots: { P: 1, R1: 1, R2: 1, R3: 1, S1: 1, S2: 1, S3: 1 } },
    indicators: { emaFast: 1, emaSlow: 2, rsi: 50 },
    trigger: "multi_indicator",
    reason: "t",
    createdAt: at(11, 45),
    entry: 64_250,
    sl: 63_400,
    tp1: 64_900,
    tp2: 65_600,
    tp3: 66_400,
  } as Signal;

  it("1. new BUY signal", () => {
    expect(messages.newSignal(btcBuy, TZ)).toBe(
      [
        "🟢 <b>BUY SIGNAL: BTCUSDT</b>",
        "",
        "Entry: 64,250.00",
        "Stop Loss: 63,400.00 (-1.3%)",
        "TP1: 64,900.00 (+1.0%)",
        "TP2: 65,600.00 (+2.1%)",
        // The example shows +3.4%, but (66,400 - 64,250) / 64,250 is 3.35%. The percentage is computed from the prices, so it is +3.3%.
        "TP3: 66,400.00 (+3.3%)",
        "",
        "Risk/Reward (to TP2): 1:1.6",
        "Time: 2026-11-07 11:45 (UTC+3)",
        "",
        "<i>Signals are not financial advice. Trade at your own risk.</i>",
      ].join("\n"),
    );
  });

  it("1b. a SELL signal has the red icon, and its targets and stop are shown in the trade's direction", () => {
    const sell = { ...btcBuy, symbol: "ETHUSDT", side: "SELL", entry: 3_412, sl: 3_453, tp1: 3_371, tp2: 3_330, tp3: 3_289, createdAt: at(16, 20) } as Signal;
    const text = messages.newSignal(sell, TZ);
    expect(text.split("\n")[0]).toBe("🔴 <b>SELL SIGNAL: ETHUSDT</b>");
    expect(text).toContain("Entry: 3,412.00");
    expect(text).toContain("Stop Loss: 3,453.00 (-1.2%)"); // the stop is above the entry: a loss
    expect(text).toContain("TP1: 3,371.00 (+1.2%)"); // the target is below the entry: a profit
    expect(text).toContain("Risk/Reward (to TP2): 1:2.0");
  });

  it("2. TP1 hit", () => {
    expect(messages.tp1Hit({ symbol: "BTCUSDT", side: "BUY", price: 64_900, entry: 64_250, at: at(13, 10) }, TZ)).toBe(
      [
        "🎯 <b>TP1 HIT: BTCUSDT BUY</b>",
        "",
        "Price: 64,900.00",
        "Closed: 25% of position",
        "Stop loss moved to entry (64,250.00)",
        "Time: 2026-11-07 13:10 (UTC+3)",
      ].join("\n"),
    );
  });

  it("3. TP2 hit", () => {
    expect(messages.tp2Hit({ symbol: "BTCUSDT", side: "BUY", price: 65_600, tp1: 64_900, at: at(15, 30) }, TZ)).toBe(
      [
        "🎯🎯 <b>TP2 HIT: BTCUSDT BUY</b>",
        "",
        "Price: 65,600.00",
        "Closed: another 25%",
        "Stop loss moved to TP1 (64,900.00)",
        "Time: 2026-11-07 15:30 (UTC+3)",
      ].join("\n"),
    );
  });

  it("4. TP3 hit, trade closed", () => {
    expect(messages.tp3Hit({ symbol: "BTCUSDT", side: "BUY", exit: 66_400, resultPercent: 2.9, exits: 3, durationMs: (4 * 60 + 12) * 60_000, at: at(18, 2) }, TZ)).toBe(
      [
        "🏁 <b>TP3 HIT: BTCUSDT BUY, TRADE CLOSED</b>",
        "",
        "Exit: 66,400.00",
        "Result: +2.9% (blended across 3 exits)",
        "Duration: 4h 12m",
        "Time: 2026-11-07 18:02 (UTC+3)",
      ].join("\n"),
    );
  });

  it("5. stop loss hit", () => {
    expect(messages.stopLossHit({ symbol: "ETHUSDT", side: "SELL", exit: 3_412, resultPercent: -1.2, durationMs: 100 * 60_000, at: at(16, 20) }, TZ)).toBe(
      [
        "🛑 <b>STOP LOSS HIT: ETHUSDT SELL</b>",
        "",
        "Exit: 3,412.00",
        "Result: -1.2%",
        "Duration: 1h 40m",
        "Time: 2026-11-07 16:20 (UTC+3)",
        "",
        "Losses are part of the strategy. Review the trade history for details.",
      ].join("\n"),
    );
  });

  it("6. closed after TP1, the rest stopped at entry", () => {
    expect(
      messages.closedAfterTp({ symbol: "SOLUSDT", side: "BUY", hits: [{ level: "TP1", percent: 0.6, share: 25 }], remainingPercent: 75, stoppedAt: "entry", netPercent: 0.15, at: at(14, 5) }, TZ),
    ).toBe(
      [
        "⚖️ <b>TRADE CLOSED: SOLUSDT BUY</b>",
        "",
        "TP1 hit (+0.6% on 25%)",
        "Remaining 75% stopped at entry",
        "Net result: +0.15%",
        "Time: 2026-11-07 14:05 (UTC+3)",
      ].join("\n"),
    );
  });

  it("6b. closed after TP2, the rest stopped at TP1, and closed at market", () => {
    const twoHits = [
      { level: "TP1" as const, percent: 1, share: 25 },
      { level: "TP2" as const, percent: 2, share: 25 },
    ];
    const text = messages.closedAfterTp({ symbol: "BTCUSDT", side: "BUY", hits: twoHits, remainingPercent: 50, stoppedAt: "TP1", netPercent: 1.25, at: at(15, 0) }, TZ);
    expect(text).toContain("TP1 hit (+1.0% on 25%)\nTP2 hit (+2.0% on 25%)\nRemaining 50% stopped at TP1\nNet result: +1.25%");
    expect(messages.closedAfterTp({ symbol: "BTCUSDT", side: "BUY", hits: twoHits, remainingPercent: 50, stoppedAt: "market", netPercent: 1, at: at(15, 0) }, TZ)).toContain("Remaining 50% closed at market");
  });

  it("7. signal expired (prices below 1 get 4 decimals)", () => {
    expect(messages.signalExpired({ symbol: "XRPUSDT", side: "BUY", hours: 24, price: 0.582, resultPercent: -0.2, at: at(22, 0) }, TZ)).toBe(
      [
        "⏱ <b>SIGNAL EXPIRED: XRPUSDT BUY</b>",
        "",
        "No TP or SL reached within 24h.",
        "Closed at market: 0.5820 (-0.2%)",
        "Time: 2026-11-07 22:00 (UTC+3)",
      ].join("\n"),
    );
  });

  it("never shows a negative zero", () => {
    expect(messages.stopLossHit({ symbol: "BTCUSDT", side: "BUY", exit: 100, resultPercent: -0.004, durationMs: 0, at: at(1, 0) }, TZ)).toContain("Result: +0.0%");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------------------------------
describe("TelegramNotifier delivery", () => {
  const tp1 = { symbol: "BTCUSDT", side: "BUY" as const, price: 64_900, entry: 64_250, at: at(13, 10) };

  function make(over: Partial<ConstructorParameters<typeof TelegramNotifier>[0]> = {}, send = vi.fn(async (_text: string) => ({ ok: true as const, messageId: 1 }))) {
    const n = new TelegramNotifier({
      client: { sendMessage: send },
      enabled: () => true,
      timeZone: () => TZ,
      sentFile: join(dir, "sent.json"),
      failedFile: join(dir, "failed.json"),
      log: silent,
      ...over,
    });
    return { n, send };
  }

  it("sends each event once per trade, and not again after a restart", async () => {
    const { n, send } = make();
    await n.tp1Hit("t1", tp1);
    await n.tp1Hit("t1", tp1);
    await Promise.all([n.tp1Hit("t2", tp1), n.tp1Hit("t2", tp1)]); // also when it is emitted twice at the same time
    expect(send).toHaveBeenCalledTimes(2);

    const again = make();
    await again.n.tp1Hit("t1", tp1);
    expect(again.send).not.toHaveBeenCalled(); // the event id is on disk
    expect(JSON.parse(readFileSync(join(dir, "sent.json"), "utf8")).map((e: { id: string }) => e.id)).toEqual(["t1:TP1", "t2:TP1"]);
  });

  it("sends nothing and throws nothing when Telegram is disabled", async () => {
    const { n, send } = make({ enabled: () => false });
    await expect(n.tp1Hit("t1", tp1)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("demo events are not sent unless postDemoEvents is on (default off)", async () => {
    const off = make();
    await off.n.tp1Hit("t1", tp1, "demo");
    expect(off.send).not.toHaveBeenCalled();

    let on = false;
    const { n, send } = make({ postDemoEvents: () => on });
    await n.tp1Hit("t1", tp1, "demo");
    expect(send).not.toHaveBeenCalled();
    on = true;
    await n.tp1Hit("t1", tp1, "demo");
    await n.tp1Hit("t1", tp1, "demo"); // still only once
    await n.tp1Hit("t1", tp1, "live"); // the strategy's own event has its own id
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toContain("Demo trade, virtual money.");
    expect(send.mock.calls[1]![0]).not.toContain("Demo trade");
  });

  it("holds back strategy messages while allowLive says no", async () => {
    let allowed = false;
    const { n, send } = make({ allowLive: () => allowed });
    await n.tp1Hit("t1", tp1);
    expect(send).not.toHaveBeenCalled();
    allowed = true;
    await n.tp1Hit("t1", tp1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never posts a test signal", async () => {
    const { n, send } = make();
    await n.newSignal({ id: "x", symbol: "BTCUSDT", side: "BUY", test: true } as Signal);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a failed message, retries it later, and clears it on success", async () => {
    const send = vi.fn(async (_text: string): Promise<{ ok: true; messageId: number } | { ok: false; reason: string }> => ({ ok: false, reason: "network" }));
    const { n } = make({}, send as never);
    await expect(n.tp1Hit("t1", tp1)).resolves.toBeUndefined(); // never throws
    expect(n.status()).toMatchObject({ failed: 1, postsLast24h: 0 });
    expect(n.recentResults()[0]).toMatchObject({ result: "failed", reason: "network", signalId: "t1:TP1" });

    await n.tp1Hit("t1", tp1); // not queued twice
    expect(n.status().failed).toBe(1);

    send.mockResolvedValue({ ok: true, messageId: 5 });
    await n.retryFailed();
    expect(n.status()).toMatchObject({ failed: 0, postsLast24h: 1 });
    expect(n.recentResults().at(-1)).toMatchObject({ result: "sent" });
  });

  it("abandons a message after 12 failed retries and stops trying", async () => {
    const send = vi.fn(async () => ({ ok: false as const, reason: "down" }));
    const { n } = make({}, send as never);
    await n.tp1Hit("t1", tp1);
    for (let i = 0; i < MAX_RETRIES; i++) await n.retryFailed();
    expect(n.status()).toMatchObject({ failed: 1, abandoned: 1 });
    const calls = send.mock.calls.length;
    await n.retryFailed();
    expect(send.mock.calls.length).toBe(calls);
  });

  it("does not crash when the client itself throws", async () => {
    const { n } = make({}, vi.fn(async () => {
      throw new Error("boom");
    }) as never);
    await expect(n.tp1Hit("t1", tp1)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// From trade events to messages
// ---------------------------------------------------------------------------------------------------------------------
describe("announcing the events of a trade", () => {
  /** A SELL at 100: stop 102, targets 98 / 96 / 94. */
  const sell = (): Signal =>
    ({
      id: "s1", symbol: "ETHUSDT", side: "SELL", timeframe: "15m", price: 100, levels: { S1: 1, R2: 2, pivots: { P: 1, R1: 1, R2: 1, R3: 1, S1: 1, S2: 1, S3: 1 } },
      indicators: { emaFast: 1, emaSlow: 2, rsi: 50 }, trigger: "multi_indicator", reason: "t", createdAt: 1_000, mode: "paper",
      entry: 100, sl: 102, tp1: 98, tp2: 96, tp3: 94, status: "OPEN", statusHistory: [{ status: "OPEN", at: 1_000, price: 100, resultR: null }], closedAt: null, resultR: null,
    }) as Signal;

  /** A channel trade followed by a notifier. Returns what was sent. */
  let runs = 0;
  function run(steps: (t: DemoTrader) => void) {
    const n = ++runs; // every run has its own saved state
    const sent: string[] = [];
    const notifier = new TelegramNotifier({
      client: { sendMessage: async (text) => (sent.push(text), { ok: true as const, messageId: 1 }) },
      enabled: () => true,
      timeZone: () => TZ,
      sentFile: join(dir, `sent-${n}.json`),
      failedFile: join(dir, `failed-${n}.json`),
      log: silent,
    });
    const t = new DemoTrader({ file: join(dir, `demo-${n}.json`), logger: silent, now: () => at(10, 0) });
    const pending: Array<Promise<void>> = [];
    t.onEvent((userId, trade, event) => pending.push(announceTradeEvent(notifier, trade, event, userId === CHANNEL_ACCOUNT ? "live" : "demo", 48)));
    t.onSignal(sell());
    steps(t);
    return Promise.all(pending).then(() => sent);
  }
  const bar = (high: number, low: number, minute: number) => ({ high, low, close: (high + low) / 2, at: at(10, minute) });

  it("TP1, TP2 and TP3 in turn, then the trade is closed with the blended result", async () => {
    const sent = await run((t) => {
      t.onBar("ETHUSDT", bar(99, 98, 30));
      t.onBar("ETHUSDT", bar(97, 96, 60));
      t.onBar("ETHUSDT", bar(95, 94, 90));
    });
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain("🎯 <b>TP1 HIT: ETHUSDT SELL</b>");
    expect(sent[0]).toContain("Stop loss moved to entry (100.00)");
    expect(sent[1]).toContain("🎯🎯 <b>TP2 HIT: ETHUSDT SELL</b>");
    expect(sent[1]).toContain("Stop loss moved to TP1 (98.00)");
    expect(sent[2]).toContain("🏁 <b>TP3 HIT: ETHUSDT SELL, TRADE CLOSED</b>");
    expect(sent[2]).toContain("Result: +4.5% (blended across 3 exits)"); // 25% x 2% + 25% x 4% + 50% x 6%
    expect(sent[2]).toContain("Duration: 1h 30m");
  });

  it("a stop before any target is a STOP LOSS HIT", async () => {
    const sent = await run((t) => t.onBar("ETHUSDT", bar(102, 100, 20)));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("🛑 <b>STOP LOSS HIT: ETHUSDT SELL</b>");
    expect(sent[0]).toContain("Exit: 102.00");
    expect(sent[0]).toContain("Result: -2.0%");
    expect(sent[0]).toContain("Duration: 20m");
  });

  it("a stop after TP1 is TRADE CLOSED with the rest stopped at entry", async () => {
    const sent = await run((t) => {
      t.onBar("ETHUSDT", bar(99, 98, 10));
      t.onBar("ETHUSDT", bar(100.5, 99, 20));
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("⚖️ <b>TRADE CLOSED: ETHUSDT SELL</b>");
    expect(sent[1]).toContain("TP1 hit (+2.0% on 25%)\nRemaining 75% stopped at entry\nNet result: +0.50%");
  });

  it("the time limit before any target is SIGNAL EXPIRED, after a target it is TRADE CLOSED at market", async () => {
    const expired = await run((t) => t.onUpdate({ ...sell(), status: "TIME_EXIT", closedAt: at(12, 0), statusHistory: [{ status: "TIME_EXIT", at: at(12, 0), price: 99, resultR: 0.5 }] } as Signal));
    expect(expired[0]).toContain("⏱ <b>SIGNAL EXPIRED: ETHUSDT SELL</b>");
    expect(expired[0]).toContain("No TP or SL reached within 48h.");
    expect(expired[0]).toContain("Closed at market: 99.00 (+1.0%)");

    const closed = await run((t) => {
      t.onBar("ETHUSDT", bar(99, 98, 10));
      t.onUpdate({ ...sell(), status: "TIME_EXIT", closedAt: at(12, 0), statusHistory: [{ status: "TIME_EXIT", at: at(12, 0), price: 99, resultR: 0.5 }] } as Signal);
    });
    expect(closed.at(-1)).toContain("Remaining 75% closed at market");
  });
});

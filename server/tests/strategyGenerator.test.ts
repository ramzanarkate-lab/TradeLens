import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_ACCOUNT, DemoTrader } from "../src/demotrade/demoTrader.js";
import { createLogger } from "../src/logging/logger.js";
import { StrategySignalGenerator, type RouteHooks } from "../src/strategies/generator.js";
import { DcaAccumulator, GridTrading, UnusualVolumeGainers } from "../src/strategies/library.js";
import { createRouting } from "../src/strategies/routing.js";
import { StrategySignalStore } from "../src/strategies/signalStore.js";
import type { Plan, Strategy } from "../src/strategies/types.js";
import { TelegramNotifier } from "../src/telegram/telegramNotifier.js";
import { announceTradeEvent } from "../src/telegram/tradeEvents.js";
import type { Candle } from "../src/types/index.js";

const silent = createLogger({ level: "silent", pretty: false });
const HOUR = 3_600_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-gen-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Flat hourly candles at 100 (high 100.5, low 99.5), volume 100. */
function flat(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: i * HOUR, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100, closed: true }));
}
/** The candle that is forming (not closed), opening at `open`. */
const forming = (i: number, open = 100): Candle => ({ time: i * HOUR, open, high: open, low: open, close: open, volume: 0, closed: false });
/** Candles inside a 100.8 entry's stop (99.79) and target (103.82). */
function calm(c: Candle[], from: number): Candle[] {
  for (let i = from; i < c.length; i++) Object.assign(c[i]!, { open: 100.8, close: 100.8, high: 101, low: 100.5, volume: 100 });
  return c;
}
/** 30 candles with a volume spike (a gainer) on candle 20, then calm candles opening at 100.8. */
function spikeSeries(n = 30): Candle[] {
  const c = flat(n);
  Object.assign(c[20]!, { volume: 400, close: 100.4, high: 100.5 });
  return calm(c, 21);
}

/** A strategy that signals once, on candle 5, with a stop 10% below and a target 100% above the entry. It has no time exit. */
const Fake: Strategy = {
  id: "Fake",
  name: "Fake",
  number: 99,
  timeframe: "1h",
  kind: "standard",
  warmup: 1,
  create: () => {
    const plan = (): Plan => ({ levels: (entry) => ({ stopLoss: entry * 0.9, targets: [entry * 2] }) });
    return { signal: (i) => (i === 5 ? plan() : null), plan };
  },
};

function setup(opts: { strategies?: Strategy[]; passed?: boolean; hooks?: RouteHooks; stateFile?: string; store?: StrategySignalStore } = {}) {
  const store = opts.store ?? new StrategySignalStore(join(dir, "signals.json"), silent);
  const hooks = opts.hooks ?? { onValidatedSignal: vi.fn(), onValidatedClosed: vi.fn() };
  const gen = new StrategySignalGenerator({ strategies: opts.strategies ?? [UnusualVolumeGainers], store, passed: () => opts.passed ?? false, hooks, logger: silent, stateFile: opts.stateFile });
  return { gen, store, hooks };
}

describe("signal generator", () => {
  it("makes a signal on the close of a candle and enters at the open of the next one", () => {
    const { gen, store } = setup();
    const c = spikeSeries();
    // only the closed candles up to the spike: the signal is made but waits for the next open
    expect(gen.processCandles("BTCUSDT", "1h", c.slice(0, 21)).created).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ id: `UnusualVolumeGainers:BTCUSDT:${20 * HOUR}`, status: "PENDING", validated: false, researchOnly: true, createdAt: 21 * HOUR });
    // the next candle opens at 100.8: that is the entry price, not the signal close (100.4)
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 21), forming(21, 100.8)]);
    expect(store.all()[0]).toMatchObject({
      status: "OPEN",
      entry: 100.8,
      filledAt: 21 * HOUR,
      strategyId: "UnusualVolumeGainers",
      symbol: "BTCUSDT",
      direction: "BUY",
      stopLoss: 100.8 * 0.99,
      targets: [100.8 * 1.03],
      tp1: 100.8 * 1.03,
      tp2: 100.8 * 1.03,
      tp3: 100.8 * 1.03,
    });
  });

  it("enters at once when the next candle has already opened", () => {
    const { gen, store } = setup();
    const c = spikeSeries();
    const r = gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 21), forming(21, 100.8)]);
    expect(r.created).toHaveLength(1);
    expect(r.entered).toHaveLength(1);
    expect(store.all()[0]!.status).toBe("OPEN");
  });

  it("keeps one open signal per strategy per symbol, and another symbol has its own", () => {
    const { gen, store } = setup();
    const c = spikeSeries(40);
    Object.assign(c[22]!, { volume: 400, close: 100.9, high: 101 }); // a second gainer while the first signal is open
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 21), forming(21, 100.8)]);
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 23), forming(23, 100.8)]);
    expect(store.all().filter((s) => s.symbol === "BTCUSDT")).toHaveLength(1);
    gen.processCandles("ETHUSDT", "1h", [...c.slice(0, 21), forming(21, 100.8)]);
    expect(store.open()).toHaveLength(2);
    expect(store.activeFor("UnusualVolumeGainers", "ETHUSDT")).toBeDefined();
  });

  it("allows a new signal once the open one has closed", () => {
    const { gen, store } = setup();
    const c = spikeSeries(45);
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 21), forming(21, 100.8)]);
    for (let n = 22; n <= 27; n++) gen.processCandles("BTCUSDT", "1h", [...c.slice(0, n), forming(n, 100.8)]); // 6 bars from the signal candle: the time exit
    expect(store.all()[0]!.outcome?.reason).toBe("TIME");
    expect(store.open()).toHaveLength(0);
    Object.assign(c[35]!, { volume: 400, close: 100.9, high: 101 });
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 36), forming(36, 100.8)]);
    expect(store.all()).toHaveLength(2);
  });

  it("never processes a candle twice, also after a restart", () => {
    const stateFile = join(dir, "state.json");
    const a = setup({ stateFile });
    const c = spikeSeries();
    const candles = [...c.slice(0, 21), forming(21, 100.8)];
    expect(a.gen.processCandles("BTCUSDT", "1h", candles).created).toHaveLength(1);
    expect(a.gen.processCandles("BTCUSDT", "1h", candles).created).toHaveLength(0);

    const b = setup({ stateFile, store: a.store }); // the server restarts: the state is read from disk
    expect(b.gen.processCandles("BTCUSDT", "1h", candles).created).toHaveLength(0);
    expect(a.store.all()).toHaveLength(1);

    // even with no saved state, the id (strategy, symbol, candle) stops a second signal for the same candle
    a.store.all()[0]!.status = "CLOSED";
    expect(setup({ store: a.store }).gen.processCandles("BTCUSDT", "1h", candles).created).toHaveLength(0);
    expect(a.store.all()).toHaveLength(1);
  });

  it("closes an open signal at market after 24 hours if no level was hit", () => {
    const { gen, store } = setup({ strategies: [Fake] });
    const c = flat(60);
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 6), forming(6)]); // signal on candle 5, entry at the open of candle 6
    expect(store.open()).toHaveLength(1);
    for (let n = 7; n <= 29; n++) gen.processCandles("BTCUSDT", "1h", [...c.slice(0, n), forming(n)]); // closes through candle 28: 23 bars from the signal
    expect(store.open()).toHaveLength(1);
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 30), forming(30)]); // candle 29 closes: 24 bars
    const s = store.all()[0]!;
    expect(s.status).toBe("CLOSED");
    expect(s.outcome).toMatchObject({ reason: "EXPIRED", exitPrice: 100, closedAt: 30 * HOUR });
  });

  it("also expires on a live price once 24 hours have passed, and ends at a level on a live price", () => {
    const { gen, store } = setup({ strategies: [Fake] });
    gen.processCandles("BTCUSDT", "1h", [...flat(6), forming(6)]);
    const created = store.all()[0]!.createdAt;
    expect(gen.onTick("BTCUSDT", 100, created + 23 * HOUR)).toHaveLength(0);
    expect(gen.onTick("BTCUSDT", 100.2, created + 24 * HOUR)[0]!.outcome).toMatchObject({ reason: "EXPIRED", exitPrice: 100.2 });

    const second = setup({ strategies: [Fake], store: new StrategySignalStore(join(dir, "s2.json"), silent) });
    second.gen.processCandles("ETHUSDT", "1h", [...flat(6), forming(6)]);
    expect(second.gen.onTick("ETHUSDT", 89, second.store.all()[0]!.createdAt + HOUR)[0]!.outcome).toMatchObject({ reason: "SL", exitPrice: 89 }); // a gap through the stop fills at the price
  });

  it("stores losses too, with their outcome", () => {
    const { gen, store } = setup({ strategies: [Fake] });
    const c = flat(10);
    Object.assign(c[7]!, { low: 85 });
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 6), forming(6)]);
    gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 8), forming(8)]);
    expect(store.all()[0]).toMatchObject({ status: "CLOSED", outcome: { reason: "SL", exitPrice: 90 } });
    expect(store.all()[0]!.outcome!.netR).toBeLessThan(-1); // costs make a stop a little worse than -1R
  });

  it("cancels a signal whose entry would be at or below its stop", () => {
    const Bad: Strategy = { ...Fake, id: "Bad", create: () => ({ signal: (i) => (i === 5 ? plan() : null), plan: () => plan() }) };
    const plan = (): Plan => ({ levels: (entry) => ({ stopLoss: entry * 1.1, targets: [] }) });
    const { gen, store } = setup({ strategies: [Bad] });
    gen.processCandles("BTCUSDT", "1h", [...flat(6), forming(6)]);
    expect(store.all()[0]).toMatchObject({ status: "CLOSED", outcome: { reason: "CANCELLED" } });
  });

  describe("GridTrading is exempt from the one-position rule", () => {
    /** 21 candles with a 90-100 range closing at 95, then a candle that reaches down to 92 (fills 3 levels at once). */
    const gridCandles = (): Candle[] => {
      const c = Array.from({ length: 22 }, (_, i): Candle => ({ time: i * HOUR, open: 95, high: 100, low: 90, close: 95, volume: 100, closed: true }));
      Object.assign(c[21]!, { high: 95.2, low: 92 });
      return c;
    };

    it("several grid positions are open at the same time, up to 5", () => {
      const { gen, store } = setup({ strategies: [GridTrading] });
      const c = gridCandles();
      gen.processCandles("BTCUSDT", "1h", c.slice(0, 21)); // sets the grid up
      gen.processCandles("BTCUSDT", "1h", c); // the next candle fills three levels
      const grid = store.open().filter((s) => s.strategyId === "GridTrading");
      expect(grid).toHaveLength(3);
      expect(new Set(grid.map((s) => s.entry)).size).toBe(3);
      expect(grid.every((s) => s.tp1 !== undefined && s.stopLoss === 90 * 0.97)).toBe(true);
    });
  });

  describe("DcaAccumulator only follows another strategy", () => {
    it("never makes an entry of its own", () => {
      const { gen, store } = setup({ strategies: [DcaAccumulator] });
      gen.processCandles("BTCUSDT", "1h", [...spikeSeries(), forming(30)]);
      expect(store.all()).toHaveLength(0);
    });

    it("follows an entered buy, adds its hourly parts while price is within +2%, and closes with its parent", () => {
      const { gen, store } = setup({ strategies: [Fake, DcaAccumulator] });
      const c = flat(60);
      gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 6), forming(6)]);
      for (let n = 7; n <= 12; n++) gen.processCandles("BTCUSDT", "1h", [...c.slice(0, n), forming(n)]);
      const dca = store.all().find((s) => s.strategyId === "DcaAccumulator")!;
      expect(dca).toMatchObject({ status: "OPEN", parentId: "Fake:BTCUSDT:" + 5 * HOUR });
      expect(dca.dca!.fills).toHaveLength(7); // 25% + six parts
      expect(dca.dca!.fills.reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1, 9);
      for (let n = 13; n <= 30; n++) gen.processCandles("BTCUSDT", "1h", [...c.slice(0, n), forming(n)]); // the parent expires after 24 bars
      expect(store.get(dca.parentId!)!.status).toBe("CLOSED");
      expect(store.get(dca.id)).toMatchObject({ status: "CLOSED", outcome: { reason: "EXPIRED" } });
    });

    it("cancels the remaining parts when price runs more than 2% above the first entry", () => {
      const { gen, store } = setup({ strategies: [Fake, DcaAccumulator] });
      const c = flat(30);
      Object.assign(c[8]!, { open: 103 });
      gen.processCandles("BTCUSDT", "1h", [...c.slice(0, 6), forming(6)]);
      for (let n = 7; n <= 12; n++) gen.processCandles("BTCUSDT", "1h", [...c.slice(0, n), forming(n, c[n]!.open)]); // a candle keeps its open when it closes
      const dca = store.all().find((s) => s.strategyId === "DcaAccumulator")!;
      expect(dca.dca!.cancelled).toBe(true);
      expect(dca.dca!.fills).toHaveLength(2); // the first 25% (candle 6) and the part at candle 7; candle 8 opens above +2% and cancels the rest
    });
  });
});

describe("routing", () => {
  function routed(passed: boolean) {
    const telegram = { newSignal: vi.fn(async () => {}) };
    const demo = { onSignal: vi.fn(), onUpdate: vi.fn() };
    const { gen, store } = setup({ strategies: [Fake], passed, hooks: createRouting({ telegram, demo }, silent) });
    return { gen, store, telegram, demo };
  }
  const run = (gen: StrategySignalGenerator) => {
    const c = flat(40);
    for (let n = 6; n <= 31; n++) gen.processCandles("BTCUSDT", "1h", [...c.slice(0, n), forming(n)]); // entry, then the 24-hour expiry
  };

  it("a NOT PASSED strategy is stored as research only and never reaches Telegram or demo", () => {
    const { gen, store, telegram, demo } = routed(false);
    run(gen);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ validated: false, researchOnly: true, status: "CLOSED" }); // it still ran and closed, for the logs
    expect(telegram.newSignal).not.toHaveBeenCalled();
    expect(demo.onSignal).not.toHaveBeenCalled();
    expect(demo.onUpdate).not.toHaveBeenCalled();
  });

  it("the routing itself refuses a signal that is not validated, even if it is handed one", () => {
    const telegram = { newSignal: vi.fn(async () => {}) };
    const demo = { onSignal: vi.fn(), onUpdate: vi.fn() };
    const hooks = createRouting({ telegram, demo }, silent);
    const base = { id: "x", strategyId: "Fake", symbol: "BTCUSDT", timeframe: "1h", direction: "BUY", entry: 100, stopLoss: 90, targets: [200], tp1: 200, tp2: 200, tp3: 200, createdAt: 1, candleTime: 0, lastCheckedCandle: 0, status: "CLOSED", outcome: { reason: "TP", exitPrice: 200, closedAt: 2, returnPercent: 100, netR: 9 } };
    hooks.onValidatedSignal({ ...base, validated: false, researchOnly: true } as never);
    hooks.onValidatedSignal({ ...base, validated: true, researchOnly: true } as never); // the flag and the check must agree
    hooks.onValidatedClosed({ ...base, validated: false, researchOnly: true } as never);
    expect(telegram.newSignal).not.toHaveBeenCalled();
    expect(demo.onSignal).not.toHaveBeenCalled();
    expect(demo.onUpdate).not.toHaveBeenCalled();
  });

  it("a PASSED strategy is stored, posted to Telegram and traded in demo, once, when it enters", () => {
    const { gen, store, telegram, demo } = routed(true);
    run(gen);
    expect(store.all()[0]).toMatchObject({ validated: true, researchOnly: false });
    expect(telegram.newSignal).toHaveBeenCalledTimes(1);
    expect(demo.onSignal).toHaveBeenCalledTimes(1);
    expect(demo.onSignal.mock.calls[0]![0]).toMatchObject({ symbol: "BTCUSDT", side: "BUY", entry: 100, sl: 90, tp1: 200, expiryHours: 24 });
    expect(demo.onUpdate).toHaveBeenCalledTimes(1); // the expiry closes the demo trade
    expect(demo.onUpdate.mock.calls[0]![0]).toMatchObject({ status: "TIME_EXIT" });
  });

  it("a validated strategy without price targets is not posted or traded (there is no template for it), and that is logged", () => {
    const NoTarget: Strategy = { ...Fake, id: "NoTarget", create: () => ({ signal: (i) => (i === 5 ? plan() : null), plan: () => plan() }) };
    const plan = (): Plan => ({ levels: (entry) => ({ stopLoss: entry * 0.98, targets: [] }) });
    const telegram = { newSignal: vi.fn(async () => {}) };
    const demo = { onSignal: vi.fn(), onUpdate: vi.fn() };
    const warn = vi.fn();
    const { gen, store } = setup({ strategies: [NoTarget], passed: true, hooks: createRouting({ telegram, demo }, { info: vi.fn(), warn }) });
    gen.processCandles("BTCUSDT", "1h", [...flat(6), forming(6)]);
    expect(store.all()).toHaveLength(1);
    expect(telegram.newSignal).not.toHaveBeenCalled();
    expect(demo.onSignal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("Telegram: once per event", () => {
  it("posts the new signal and the expiry once each, however often they are triggered", async () => {
    const sent: string[] = [];
    const notifier = new TelegramNotifier({
      client: { sendMessage: async (text) => (sent.push(text), { ok: true as const, messageId: sent.length }) },
      enabled: () => true,
      timeZone: () => "Asia/Riyadh",
      sentFile: join(dir, "sent.json"),
      failedFile: join(dir, "failed.json"),
      log: silent,
    });
    const demo = new DemoTrader({ file: join(dir, "demo.json"), logger: silent, now: () => 6 * HOUR });
    const pending: Array<Promise<void>> = [];
    demo.onEvent((userId, trade, event) => pending.push(announceTradeEvent(notifier, trade, event, userId === CHANNEL_ACCOUNT ? "live" : "demo", 48)));

    const { gen } = setup({ strategies: [Fake], passed: true, hooks: createRouting({ telegram: notifier, demo }, silent) });
    const c = flat(40);
    for (let n = 6; n <= 31; n++) gen.processCandles("BTCUSDT", "1h", [...c.slice(0, n), forming(n)]);
    gen.onTick("BTCUSDT", 100, 100 * HOUR); // late ticks change nothing: the signal is closed
    await Promise.all(pending);
    await Promise.resolve();

    await notifier.newSignal({ id: `Fake:BTCUSDT:${5 * HOUR}`, symbol: "BTCUSDT", side: "BUY", entry: 100, sl: 90, tp1: 200, tp2: 200, tp3: 200, createdAt: 6 * HOUR } as never); // the same signal again
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("🟢 <b>BUY SIGNAL: BTCUSDT</b>");
    expect(sent[0]!.trimEnd().endsWith("<i>Signals are not financial advice. Trade at your own risk.</i>")).toBe(true);
    expect(sent[1]).toContain("⏱ <b>SIGNAL EXPIRED: BTCUSDT BUY</b>");
    expect(sent[1]).toContain("No TP or SL reached within 24h."); // not the engine's 48h
  });
});

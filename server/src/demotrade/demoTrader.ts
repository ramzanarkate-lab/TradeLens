import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.js";
import { isActive } from "../signals/lifecycle.js";
import { movePercent } from "../signals/levels.js";
import type { Signal, SignalSide } from "../types/index.js";

/** Every user's virtual balance starts at (and a refill goes back to) this many USDT. */
export const START_BALANCE = 10_000;
/** A balance refill is allowed once every 24 hours. */
export const REFILL_COOLDOWN_MS = 24 * 60 * 60_000;

/** Share of the ORIGINAL position closed at TP1 and at TP2. TP3 closes whatever is left (50%). */
const TP1_SHARE = 0.25;
const TP2_SHARE = 0.25;

export interface DemoSettings {
  /** When false, new signals are not traded (open trades still run to their end). */
  enabled: boolean;
  /** Position size of every demo trade, in USDT. */
  tradeSizeUsd: number;
  /** Fee per side, in percent of the traded value. */
  feePercent: number;
}

export const DEFAULT_DEMO_SETTINGS: DemoSettings = { enabled: true, tradeSizeUsd: 1000, feePercent: 0.04 };

export type DemoLevel = "OPEN" | "TP1" | "TP2" | "TP3" | "SL" | "TIME";

/** One line of a trade's history. */
export interface DemoEvent {
  at: number;
  level: DemoLevel;
  price: number;
  /** Share of the original position closed by this event, in percent (0 for OPEN). */
  closedPercent: number;
  /** Profit or loss booked by this event, after fees (0 for OPEN). */
  pnl: number;
  note: string;
}

export interface DemoTrade {
  /** The id of the signal this trade follows. */
  id: string;
  symbol: string;
  side: SignalSide;
  entry: number;
  /** The stop of the signal. */
  initialSl: number;
  /** The stop in force now: initial, then the entry (after TP1), then TP1 (after TP2). */
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Original size in coins, and what is still open. */
  qty: number;
  qtyLeft: number;
  /** Value at entry, in USDT. */
  notional: number;
  openedAt: number;
  /** Open time of the newest candle already applied (candles are never applied twice). */
  lastCandle: number;
  /** 0 = nothing hit yet, 1 = TP1 hit, 2 = TP2 hit, 3 = TP3 hit. */
  stage: 0 | 1 | 2 | 3;
  state: "OPEN" | "CLOSED";
  levels: { tp1: "PENDING" | "HIT"; tp2: "PENDING" | "HIT"; tp3: "PENDING" | "HIT"; sl: "PENDING" | "HIT" };
  events: DemoEvent[];
  /** Profit or loss booked so far (partial closes count at once). */
  realizedPnl: number;
  closedAt?: number;
  /** Hours after which the signal expires at market, when the signal says so (used in the Telegram message). */
  expiryHours?: number;
  /** Set when closed: WIN (TP3 or time exit in profit), PARTIAL_WIN (stopped after TP1), LOSS, BREAKEVEN. */
  result?: "WIN" | "PARTIAL_WIN" | "LOSS" | "BREAKEVEN";
}

interface Account {
  /** Virtual cash in USDT: the starting 10000 plus every profit and loss booked since the last refill. */
  balance: number;
  lastRefillAt: number | null;
  createdAt: number;
  trades: DemoTrade[];
}

interface Persisted {
  settings: DemoSettings;
  /** Keyed by user id. */
  accounts: Record<string, Account>;
}

/** A price window: a closed candle, or one live price (high = low = close). */
export interface DemoBar {
  high: number;
  low: number;
  close: number;
  /** Epoch ms of the bar's close (or of the live price). */
  at: number;
  /** Open time of the candle, when the bar is a candle. */
  candleTime?: number;
}

export interface DemoTraderDeps {
  file: string;
  logger: Logger;
  /** Latest known price of a symbol, for the profit of open trades. */
  price?: (symbol: string) => number | undefined;
  /** Signals that are running now. A new account trades them straight away. */
  activeSignals?: () => Signal[];
  /** Whether the channel account follows a new signal (the server skips signals made before it started). Default: yes. */
  channelAccepts?: (signal: Signal) => boolean;
  now?: () => number;
}

export interface DemoSummary {
  enabled: boolean;
  tradeSizeUsd: number;
  startingBalance: number;
  /** Virtual cash: 10000 plus booked profit and loss since the last refill. */
  balance: number;
  /** Profit or loss of the part of open trades that is still open, at the latest price. */
  openPnl: number;
  /** Profit or loss already booked by all trades (partial closes included). */
  closedPnl: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  refill: { available: boolean; secondsLeft: number };
}

export type DemoEventListener = (userId: string, trade: DemoTrade, event: DemoEvent) => void;

const money = (n: number) => Math.round(n * 100) / 100;
const coins = (n: number) => Math.round(n * 1e8) / 1e8;
/** Percent from the entry in the trade's direction: a target is positive, a stop negative. */
const pct = (side: SignalSide, price: number, entry: number) => Math.round(movePercent(side, entry, price) * 100) / 100;

/** The account that follows every strategy signal for the Telegram channel. It is not a user and never appears in the app. */
export const CHANNEL_ACCOUNT = "__channel__";

/** Result of a whole trade in percent, blended over its exits (each exit counts for the share of the position it closed). */
export function blendedPercent(t: Pick<DemoTrade, "side" | "entry" | "events">): number {
  return t.events.filter((e) => e.level !== "OPEN").reduce((sum, e) => sum + (e.closedPercent / 100) * movePercent(t.side, t.entry, e.price), 0);
}

/**
 * A virtual trading account for every user. Each signal the engine creates is traded automatically, with no manual trades.
 *  - TP1 hit: 25% of the position is closed and the stop moves to the entry.
 *  - TP2 hit: another 25% is closed and the stop moves to TP1.
 *  - TP3 hit: the remaining 50% is closed and the trade is a full win.
 *  - Stop hit at any stage: whatever is left closes at the stop. A trade that already hit TP1 is a partial win.
 * Every event is kept in the trade's history. Demo accounts are completely separate from the live signals' own results.
 */
export class DemoTrader {
  private data: Persisted;
  private readonly now: () => number;
  private readonly listeners: DemoEventListener[] = [];

  constructor(private readonly d: DemoTraderDeps) {
    this.now = d.now ?? Date.now;
    this.data = this.load();
    if (!this.data.accounts[CHANNEL_ACCOUNT]) this.data.accounts[CHANNEL_ACCOUNT] = { balance: START_BALANCE, lastRefillAt: null, createdAt: this.now(), trades: [] };
  }

  /** Called for every event of every trade (opening, TP1, TP2, TP3, stop, time exit). A throwing listener never stops trading. */
  onEvent(listener: DemoEventListener): void {
    this.listeners.push(listener);
  }

  settings(): DemoSettings {
    return { ...this.data.settings };
  }

  updateSettings(patch: Partial<DemoSettings>): DemoSettings {
    const next = { ...this.data.settings, ...patch };
    const ok = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
    if (typeof next.enabled !== "boolean") throw new Error("enabled must be true or false");
    if (!ok(next.tradeSizeUsd, 1, 1_000_000)) throw new Error("tradeSizeUsd must be between 1 and 1,000,000");
    if (!ok(next.feePercent, 0, 1)) throw new Error("feePercent must be between 0 and 1");
    this.data.settings = next;
    this.save();
    return this.settings();
  }

  /** The user's account. The first time, it is created with 10000 USDT and trades the signals that are running now. */
  private account(userId: string): Account {
    let acc = this.data.accounts[userId];
    if (!acc) {
      acc = { balance: START_BALANCE, lastRefillAt: null, createdAt: this.now(), trades: [] };
      this.data.accounts[userId] = acc;
      if (userId !== CHANNEL_ACCOUNT) for (const s of this.d.activeSignals?.() ?? []) this.open(userId, acc, s);
      this.save();
    }
    return acc;
  }

  /** A new signal: every existing account opens a trade for it. */
  onSignal(signal: Signal): void {
    for (const [userId, acc] of Object.entries(this.data.accounts)) {
      if (userId === CHANNEL_ACCOUNT && this.d.channelAccepts && !this.d.channelAccepts(signal)) continue;
      this.open(userId, acc, signal);
    }
    this.save();
  }

  /** A price or candle for a symbol: moves every open trade of that symbol through its levels. */
  onBar(symbol: string, bar: DemoBar): void {
    let changed = false;
    for (const [userId, acc] of Object.entries(this.data.accounts)) {
      for (const t of acc.trades) {
        if (t.state !== "OPEN" || t.symbol !== symbol) continue;
        if (bar.candleTime !== undefined) {
          if (bar.candleTime < t.openedAt || bar.candleTime <= t.lastCandle) continue; // before the trade, or already applied
          t.lastCandle = bar.candleTime;
          changed = true;
        } else if (bar.at < t.openedAt) continue;
        if (this.step(userId, acc, t, bar)) changed = true;
      }
    }
    if (changed) this.save();
  }

  /** A signal changed status. If it has closed (for example a time exit) and a demo trade is still open, that trade closes too. */
  onUpdate(signal: Signal): void {
    if (isActive(signal) || !signal.closedAt) return;
    const last = signal.statusHistory?.at(-1);
    if (!last) return;
    let changed = false;
    for (const [userId, acc] of Object.entries(this.data.accounts)) {
      const t = acc.trades.find((x) => x.id === signal.id && x.state === "OPEN");
      if (!t) continue;
      const level: DemoLevel = signal.status === "TIME_EXIT" ? "TIME" : signal.status === "TP3_HIT" ? "TP3" : "SL";
      this.close(userId, acc, t, level, last.price, last.at, level === "TIME" ? "Time limit reached" : "Closed with the signal");
      changed = true;
    }
    if (changed) this.save();
  }

  /** Puts the balance back to 10000. Allowed once every 24 hours. Open trades are untouched. */
  refill(userId: string): { ok: true; balance: number } | { ok: false; secondsLeft: number } {
    const acc = this.account(userId);
    const left = this.refillSecondsLeft(acc);
    if (left > 0) return { ok: false, secondsLeft: left };
    acc.balance = START_BALANCE;
    acc.lastRefillAt = this.now();
    this.save();
    this.d.logger.info({ userId }, "demo balance refilled");
    return { ok: true, balance: acc.balance };
  }

  /** Everything the Signals screen needs for one user. */
  view(userId: string) {
    const acc = this.account(userId);
    const open = acc.trades.filter((t) => t.state === "OPEN").map((t) => this.tradeView(t));
    const closed = acc.trades.filter((t) => t.state === "CLOSED").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    return {
      summary: this.summary(acc, open),
      open: open.sort((a, b) => b.openedAt - a.openedAt),
      closed: closed.slice(0, 50).map((t) => this.tradeView(t)),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private summary(acc: Account, open: ReturnType<DemoTrader["tradeView"]>[]): DemoSummary {
    const closed = acc.trades.filter((t) => t.state === "CLOSED");
    const wins = closed.filter((t) => t.result === "WIN" || t.result === "PARTIAL_WIN").length;
    const left = this.refillSecondsLeft(acc);
    return {
      enabled: this.data.settings.enabled,
      tradeSizeUsd: this.data.settings.tradeSizeUsd,
      startingBalance: START_BALANCE,
      balance: money(acc.balance),
      openPnl: money(open.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0)),
      closedPnl: money(acc.trades.reduce((s, t) => s + t.realizedPnl, 0)),
      openCount: open.length,
      closedCount: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
      refill: { available: left === 0, secondsLeft: left },
    };
  }

  private refillSecondsLeft(acc: Account): number {
    if (acc.lastRefillAt === null) return 0;
    return Math.max(0, Math.ceil((acc.lastRefillAt + REFILL_COOLDOWN_MS - this.now()) / 1000));
  }

  private tradeView(t: DemoTrade) {
    const price = t.state === "OPEN" ? (this.d.price?.(t.symbol) ?? null) : null;
    const buy = t.side === "BUY";
    const unrealized = price === null ? null : money((buy ? price - t.entry : t.entry - price) * t.qtyLeft);
    const hit = (key: "tp1" | "tp2" | "tp3" | "sl", label: string) => (t.levels[key] === "HIT" ? `${label} Hit` : "Pending");
    return {
      ...t,
      price,
      unrealizedPnl: unrealized,
      levelStatus: [
        { name: "TP1", price: t.tp1, percentFromEntry: pct(t.side, t.tp1, t.entry), status: hit("tp1", "TP1") },
        { name: "TP2", price: t.tp2, percentFromEntry: pct(t.side, t.tp2, t.entry), status: hit("tp2", "TP2") },
        { name: "TP3", price: t.tp3, percentFromEntry: pct(t.side, t.tp3, t.entry), status: hit("tp3", "TP3") },
        { name: "SL", price: t.sl, percentFromEntry: pct(t.side, t.sl, t.entry), status: hit("sl", "SL") },
      ],
    };
  }

  private open(userId: string, acc: Account, signal: Signal): void {
    const { settings } = this.data;
    if (!settings.enabled || signal.test || !isActive(signal)) return;
    if (acc.trades.some((t) => t.id === signal.id)) return;
    const { entry, sl, tp1, tp2, tp3 } = signal;
    if (![entry, sl, tp1, tp2, tp3].every((v) => typeof v === "number" && v > 0) || entry === sl) return;

    // Money already working in open trades cannot be used again.
    const inUse = acc.trades.filter((t) => t.state === "OPEN").reduce((s, t) => s + t.qtyLeft * t.entry, 0);
    if (userId !== CHANNEL_ACCOUNT && acc.balance - inUse < settings.tradeSizeUsd) {
      this.d.logger.info({ userId, id: signal.id }, "demo balance too low for another trade: signal skipped (refill to continue)");
      return;
    }
    const qty = coins(settings.tradeSizeUsd / entry!);
    const now = this.now();
    const trade: DemoTrade = {
      id: signal.id,
      symbol: signal.symbol,
      side: signal.side,
      entry: entry!,
      initialSl: sl!,
      sl: sl!,
      tp1: tp1!,
      tp2: tp2!,
      tp3: tp3!,
      qty,
      qtyLeft: qty,
      notional: money(qty * entry!),
      openedAt: now,
      lastCandle: -1,
      stage: 0,
      state: "OPEN",
      levels: { tp1: "PENDING", tp2: "PENDING", tp3: "PENDING", sl: "PENDING" },
      events: [],
      realizedPnl: 0,
      ...(signal.expiryHours ? { expiryHours: signal.expiryHours } : {}),
    };
    acc.trades.push(trade);
    this.record(userId, trade, { at: now, level: "OPEN", price: entry!, closedPercent: 0, pnl: 0, note: `Demo ${signal.side} opened with ${settings.tradeSizeUsd} USDT` });
  }

  /** Moves one trade through one price window. Returns true if anything happened. The stop is checked first (the cautious assumption). */
  private step(userId: string, acc: Account, t: DemoTrade, bar: DemoBar): boolean {
    const buy = t.side === "BUY";
    const touchesStop = (p: number) => (buy ? bar.low <= p : bar.high >= p);
    const touchesTarget = (p: number) => (buy ? bar.high >= p : bar.low <= p);
    let changed = false;
    while (t.state === "OPEN") {
      if (touchesStop(t.sl)) {
        const note = t.stage === 0 ? "Stop loss hit" : t.stage === 1 ? "Stopped at the entry after TP1" : "Stopped at TP1 after TP2";
        this.close(userId, acc, t, "SL", t.sl, bar.at, note);
        return true;
      }
      const target = t.stage === 0 ? t.tp1 : t.stage === 1 ? t.tp2 : t.tp3;
      if (!touchesTarget(target)) break;
      if (t.stage === 0) {
        this.partial(userId, acc, t, "TP1", t.tp1, bar.at, TP1_SHARE, "TP1 hit: 25% closed, stop moved to the entry");
        t.sl = t.entry;
        t.stage = 1;
        t.levels.tp1 = "HIT";
      } else if (t.stage === 1) {
        this.partial(userId, acc, t, "TP2", t.tp2, bar.at, TP2_SHARE, "TP2 hit: another 25% closed, stop moved to TP1");
        t.sl = t.tp1;
        t.stage = 2;
        t.levels.tp2 = "HIT";
      } else {
        this.close(userId, acc, t, "TP3", t.tp3, bar.at, "TP3 hit: the remaining 50% closed, full win");
        return true;
      }
      changed = true;
    }
    return changed;
  }

  private partial(userId: string, acc: Account, t: DemoTrade, level: DemoLevel, price: number, at: number, share: number, note: string): void {
    this.book(userId, acc, t, level, price, at, Math.min(t.qtyLeft, coins(t.qty * share)), note);
  }

  /** Closes everything that is left and decides the result of the trade. */
  private close(userId: string, acc: Account, t: DemoTrade, level: DemoLevel, price: number, at: number, note: string): void {
    if (level === "TP3") {
      t.levels.tp3 = "HIT";
      t.stage = 3;
    }
    if (level === "SL") t.levels.sl = "HIT";
    this.book(userId, acc, t, level, price, at, t.qtyLeft, note);
    t.state = "CLOSED";
    t.closedAt = at;
    t.qtyLeft = 0;
    t.result = t.levels.tp3 === "HIT" ? "WIN" : t.levels.tp1 === "HIT" && level === "SL" ? "PARTIAL_WIN" : t.realizedPnl > 0.005 ? "WIN" : t.realizedPnl < -0.005 ? "LOSS" : "BREAKEVEN";
  }

  /** Closes `qty` coins at `price`: books profit or loss (after fees) into the trade and the account, and records the event. */
  private book(userId: string, acc: Account, t: DemoTrade, level: DemoLevel, price: number, at: number, qty: number, note: string): void {
    const { feePercent } = this.data.settings;
    const gross = (t.side === "BUY" ? price - t.entry : t.entry - price) * qty;
    const fees = qty * t.entry * (feePercent / 100) * 2; // entry and exit fee of the part that closes
    const pnl = money(gross - fees);
    t.qtyLeft = coins(t.qtyLeft - qty);
    t.realizedPnl = money(t.realizedPnl + pnl);
    acc.balance = money(acc.balance + pnl);
    this.record(userId, t, { at, level, price, closedPercent: Math.round((qty / t.qty) * 10_000) / 100, pnl, note });
  }

  private record(userId: string, t: DemoTrade, event: DemoEvent): void {
    t.events.push(event);
    this.d.logger.info({ userId, id: t.id, symbol: t.symbol, level: event.level, price: event.price, pnl: event.pnl }, "demo trade event");
    for (const l of this.listeners) {
      try {
        l(userId, t, event);
      } catch (err) {
        this.d.logger.error({ err }, "demo event listener failed");
      }
    }
  }

  private load(): Persisted {
    const fresh = (): Persisted => ({ settings: { ...DEFAULT_DEMO_SETTINGS }, accounts: {} });
    try {
      if (!existsSync(this.d.file)) return fresh();
      const raw = JSON.parse(readFileSync(this.d.file, "utf8")) as Partial<Persisted>;
      return { settings: { ...DEFAULT_DEMO_SETTINGS, ...(raw.settings ?? {}) }, accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {} };
    } catch (err) {
      this.d.logger.error({ err: err instanceof Error ? err.message : String(err) }, "demo accounts file unreadable: starting empty");
      return fresh();
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.d.file), { recursive: true });
      writeFileSync(`${this.d.file}.tmp`, JSON.stringify(this.data));
      renameSync(`${this.d.file}.tmp`, this.d.file);
    } catch (err) {
      this.d.logger.error({ err: err instanceof Error ? err.message : String(err) }, "could not save demo accounts");
    }
  }
}

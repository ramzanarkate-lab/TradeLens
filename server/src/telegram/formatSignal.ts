import { PRICE_DECIMALS } from "../analysis/pivots.js";
import type { Signal, StatusChange } from "../types/index.js";

export interface FormatOptions {
  timeZone: string;
  emaFast?: number;
  emaSlow?: number;
  rsiPeriod?: number;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function number(value: number, decimals: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

/** "2026-11-06 16:20 (UTC+3)" in the given IANA zone. */
export function formatTime(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // "GMT+03:00" -> "UTC+3", "GMT+05:30" -> "UTC+5:30", "GMT" -> "UTC"
  const offset = get("timeZoneName")
    .replace("GMT", "UTC")
    .replace(/([+-])0?(\d{1,2}):00$/, "$1$2")
    .replace(/([+-])0?(\d{1,2}):(\d{2})$/, "$1$2:$3")
    .replace(/UTC[+-]0$/, "UTC");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} (${offset})`;
}

const DISCLAIMER = "Not financial advice. Trade at your own risk.";
const signed = (r: number) => `${r >= 0 ? "+" : "-"}${Math.abs(r).toFixed(1)}R`;

/** The lines shared by a new signal and its status updates: header, entry, stop, three targets. */
function levelLines(signal: Signal): string[] {
  const d = PRICE_DECIMALS[signal.symbol];
  const icon = signal.side === "BUY" ? "🟢" : "🔴";
  return [
    `<b>${icon} ${signal.side} ${escapeHtml(signal.symbol)}</b> (${escapeHtml(signal.timeframe)}) · Score ${signal.score}/100`,
    `Entry: ${number(signal.entry!, d)}`,
    `SL: ${number(signal.sl!, d)} (risk ${signal.riskPercent!.toFixed(2)}%)`,
    `TP1: ${number(signal.tp1!, d)} (${signal.rrTp1!.toFixed(1)}R)`,
    `TP2: ${number(signal.tp2!, d)} (${signal.rrTp2!.toFixed(1)}R)`,
    `TP3: ${number(signal.tp3!, d)} (${signal.rrTp3!.toFixed(1)}R)`,
  ];
}

/** Second message when a signal reaches TP1, TP2, TP3 or its stop: same layout, with the result in R. */
export function formatStatusUpdate(signal: Signal, change: StatusChange, opts: FormatOptions): string {
  const label = change.status.replace("_", " ");
  return [
    ...levelLines(signal),
    `Update: <b>${escapeHtml(label)}</b> at ${number(change.price, PRICE_DECIMALS[signal.symbol])} (${signed(change.resultR ?? 0)})`,
    `Time: ${formatTime(change.at, opts.timeZone)}`,
    "",
    DISCLAIMER,
  ].join("\n");
}

export function formatSignal(signal: Signal, opts: FormatOptions): string {
  if (signal.entry !== undefined && signal.sl !== undefined && signal.score !== undefined) {
    const why = (signal.reasons ?? []).slice(0, 3).map((r) => `• ${escapeHtml(r)}`);
    const lead = signal.news?.headlines.reduce((a, b) => (Math.abs(b.score) > Math.abs(a.score) ? b : a));
    const news = signal.news && lead ? [`News: +${signal.news.points} points (${escapeHtml(lead.headline.length > 60 ? `${lead.headline.slice(0, 57)}...` : lead.headline)}, ${lead.minutesAgo} min ago)`] : [];
    return [...levelLines(signal), ...(why.length ? ["Why:", ...why] : []), ...news, `Time: ${formatTime(signal.createdAt, opts.timeZone)}`, "", DISCLAIMER].join("\n");
  }
  const d = PRICE_DECIMALS[signal.symbol];
  const icon = signal.side === "BUY" ? "🟢" : "🔴";
  const fast = opts.emaFast ?? 20;
  const slow = opts.emaSlow ?? 50;
  const period = opts.rsiPeriod ?? 14;
  return [
    `<b>${icon} ${signal.side} ${escapeHtml(signal.symbol)}</b> (${escapeHtml(signal.timeframe)})`,
    `Price: ${number(signal.price, d)}`,
    `Support S1: ${number(signal.levels.S1, d)} | Resistance R2: ${number(signal.levels.R2, d)}`,
    `EMA${fast} / EMA${slow}: ${number(signal.indicators.emaFast, d)} / ${number(signal.indicators.emaSlow, d)}`,
    `RSI(${period}): ${number(signal.indicators.rsi, 1)}`,
    `Reason: ${escapeHtml(signal.reason)}`,
    `Time: ${formatTime(signal.createdAt, opts.timeZone)}`,
    "",
    "Not financial advice. Trade at your own risk.",
  ].join("\n");
}

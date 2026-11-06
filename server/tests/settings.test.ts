import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../src/http/errors.js";
import { createLogger } from "../src/logging/logger.js";
import { DEFAULT_SETTINGS } from "../src/settings/schema.js";
import { SettingsStore, StoreSignalSettings, type SettingsChange } from "../src/settings/store.js";

const logger = createLogger({ level: "silent", pretty: false });

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tradelens-settings-"));
  file = join(dir, "data", "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const fresh = () => {
  const store = new SettingsStore(file, logger);
  store.load();
  return store;
};

const rejects = (fn: () => unknown, message: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
    expect((err as AppError).message).toMatch(message);
    return;
  }
  throw new Error("expected the update to be rejected");
};

describe("defaults", () => {
  it("match the specification", () => {
    expect(fresh().get()).toEqual({
      signals: { emaFast: 20, emaSlow: 50, rsiPeriod: 14, rsiBuyMin: 40, rsiBuyMax: 65, rsiSellAbove: 75, cooldownMinutes: 60, timeframe: "1h",
        minScore: 70, minRiskPercent: 0.4, maxRiskPercent: 4.0, timeStopHours: 48, mode: "paper",
        backtestMinProfitFactor: 1.3, backtestMinTrades: 30, backtestMaxDrawdownR: 10,
        reversalEnabled: true, reversalMinVolumeRatio: 1.2, reversalLevelToleranceAtr: 0.5,
        reversalPatterns: { hammer: true, engulfing: true, piercing: true, morningStar: true, tweezer: true },
        newsEnabled: true, newsWindowMinutes: 60, newsBoostPoints: 5, newsVetoEnabled: true,
      },
      symbols: { enabled: ["BTCUSDT", "SOLUSDT", "ETHUSDT"] },
      chart: { defaultSymbol: "BTCUSDT", defaultTimeframe: "1h", showPivots: true, showVolume: true, showEma: true },
      alerts: { sound: true, vibration: true, popup: true, backgroundService: true },
      general: { language: "en", theme: "dark" },
    });
  });

  it("are not mutated by updates", async () => {
    const store = fresh();
    store.update("chart", { showPivots: false });
    expect(DEFAULT_SETTINGS.chart.showPivots).toBe(true);
  });
});

describe("validation", () => {
  it("accepts valid updates and merges partial ones", () => {
    const store = fresh();
    expect(store.update("signals", { emaFast: 9, emaSlow: 21 })).toMatchObject({ emaFast: 9, emaSlow: 21, rsiPeriod: 14 });
    expect(store.update("general", { theme: "light" })).toEqual({ language: "en", theme: "light" });
    expect(store.update("symbols", { enabled: ["ETHUSDT"] })).toEqual({ enabled: ["ETHUSDT"] });
  });

  it("rejects emaFast >= emaSlow, including through a partial update, and leaves settings unchanged", () => {
    const store = fresh();
    rejects(() => store.update("signals", { emaFast: 50, emaSlow: 50 }), /emaFast must be less than emaSlow/);
    rejects(() => store.update("signals", { emaFast: 60, emaSlow: 50 }), /emaFast must be less than emaSlow/);
    rejects(() => store.update("signals", { emaFast: 60 }), /emaFast must be less than emaSlow/); // stored emaSlow is 50
    rejects(() => store.update("signals", { emaSlow: 10 }), /emaFast must be less than emaSlow/); // stored emaFast is 20
    expect(store.section("signals")).toEqual(DEFAULT_SETTINGS.signals);
  });

  it("enforces numeric ranges", () => {
    const store = fresh();
    rejects(() => store.update("signals", { emaFast: 1 }), /emaFast/);
    rejects(() => store.update("signals", { emaSlow: 201 }), /emaSlow/);
    rejects(() => store.update("signals", { emaFast: 20.5 }), /emaFast/);
    rejects(() => store.update("signals", { rsiPeriod: 1 }), /rsiPeriod/);
    rejects(() => store.update("signals", { rsiBuyMin: 0 }), /rsiBuyMin/);
    rejects(() => store.update("signals", { rsiBuyMax: 100 }), /rsiBuyMax/);
    rejects(() => store.update("signals", { rsiSellAbove: 100 }), /rsiSellAbove/);
    rejects(() => store.update("signals", { cooldownMinutes: -1 }), /cooldownMinutes/);
    rejects(() => store.update("signals", { emaFast: "20" }), /emaFast/); // wrong type
    // boundaries are allowed
    expect(store.update("signals", { emaFast: 2, emaSlow: 200, rsiBuyMin: 1, rsiBuyMax: 99, rsiSellAbove: 99 })).toMatchObject({ emaFast: 2, emaSlow: 200 });
  });

  it("requires rsiBuyMin < rsiBuyMax", () => {
    const store = fresh();
    rejects(() => store.update("signals", { rsiBuyMin: 70 }), /rsiBuyMin must be less than rsiBuyMax/); // stored max is 65
  });

  it("allows only the supported timeframes", () => {
    const store = fresh();
    for (const tf of ["15m", "1h", "4h", "1d"]) expect(store.update("signals", { timeframe: tf })).toMatchObject({ timeframe: tf });
    rejects(() => store.update("signals", { timeframe: "5m" }), /timeframe/);
    rejects(() => store.update("chart", { defaultTimeframe: "1w" }), /defaultTimeframe/);
  });

  it("requires enabled symbols to be a non-empty, duplicate-free subset of the allowed list", () => {
    const store = fresh();
    rejects(() => store.update("symbols", { enabled: ["BTCUSDT", "DOGEUSDT"] }), /symbols\.enabled/);
    rejects(() => store.update("symbols", { enabled: [] }), /at least one/);
    rejects(() => store.update("symbols", { enabled: ["BTCUSDT", "BTCUSDT"] }), /must not repeat/);
    rejects(() => store.update("chart", { defaultSymbol: "DOGEUSDT" }), /defaultSymbol/);
  });

  it("rejects unknown keys in every section", () => {
    const store = fresh();
    for (const section of ["signals", "symbols", "chart", "alerts", "general"] as const) {
      rejects(() => store.update(section, { surprise: 1 }), /surprise|Unrecognized/i);
    }
    rejects(() => store.update("alerts", { sound: true, loud: true }), /loud|Unrecognized/i);
  });

  it("rejects non-object bodies", () => {
    const store = fresh();
    rejects(() => store.update("alerts", null), /alerts/);
    rejects(() => store.update("alerts", [1]), /alerts/);
    rejects(() => store.update("alerts", "sound"), /alerts/);
  });
});

describe("persistence and reload", () => {
  it("writes settings.json and reloads it", async () => {
    const a = fresh();
    a.update("signals", { emaFast: 12, emaSlow: 26 });
    a.update("general", { theme: "light" });
    await a.flush();

    expect(JSON.parse(readFileSync(file, "utf8")).signals).toMatchObject({ emaFast: 12, emaSlow: 26 });
    const b = fresh();
    expect(b.section("signals")).toMatchObject({ emaFast: 12, emaSlow: 26 });
    expect(b.section("general").theme).toBe("light");
  });

  it("emits a changed event with the section name", () => {
    const store = fresh();
    const events: SettingsChange[] = [];
    store.on("changed", (e: SettingsChange) => events.push(e));
    store.update("chart", { showVolume: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ section: "chart" });
    rejects(() => store.update("chart", { showVolume: "no" }), /showVolume/);
    expect(events).toHaveLength(1); // a rejected update emits nothing
  });

  it("falls back to defaults for an invalid stored section but keeps the valid ones", async () => {
    const seed = fresh();
    await seed.flush();
    writeFileSync(
      file,
      JSON.stringify({ signals: { emaFast: 80, emaSlow: 20 }, chart: { showPivots: false }, alerts: { sound: false, bogus: 1 } }),
    );
    const store = fresh();
    expect(store.section("signals")).toEqual(DEFAULT_SETTINGS.signals); // fast >= slow
    expect(store.section("alerts")).toEqual(DEFAULT_SETTINGS.alerts); // unknown key
    expect(store.section("chart")).toMatchObject({ showPivots: false, defaultSymbol: "BTCUSDT" }); // merged over defaults
  });

  it("sets a corrupt file aside and starts from defaults", () => {
    const seed = fresh();
    void seed;
    writeFileSync(file, "{nope");
    const store = fresh();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(dir, "data")).some((f) => f.startsWith("settings.json.corrupt-"))).toBe(true);
  });
});

describe("StoreSignalSettings (engine reload without restart)", () => {
  it("returns the current store values on every call", () => {
    const store = fresh();
    const provider = new StoreSignalSettings(store);
    expect(provider.get()).toMatchObject({ emaFast: 20, emaSlow: 50, timeframe: "1h", enabled: true });

    store.update("signals", { emaFast: 10, emaSlow: 30, timeframe: "4h" });
    store.update("symbols", { enabled: ["SOLUSDT"] });
    expect(provider.get()).toMatchObject({ emaFast: 10, emaSlow: 30, timeframe: "4h", enabledSymbols: ["SOLUSDT"] });
  });
});

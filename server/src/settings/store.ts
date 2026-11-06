import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_SIGNAL_SETTINGS, type SignalSettings } from "../config/signalDefaults.js";
import { AppError } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { Settings } from "../types/index.js";
import type { SignalSettingsProvider } from "../signals/settingsProvider.js";
import { DEFAULT_SETTINGS, SECTION_NAMES, describeIssues, patchSchemas, sectionSchemas, type SectionName } from "./schema.js";

export interface SettingsChange {
  section: SectionName;
  at: number;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Non-secret settings kept in memory and persisted to a JSON file. Emits "changed" (SettingsChange)
 * after every successful update, so listeners can reload without a restart.
 */
export class SettingsStore extends EventEmitter {
  private settings: Settings = clone(DEFAULT_SETTINGS) as Settings;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  /** Loads the file, section by section. Anything missing or invalid falls back to that section's defaults. */
  load(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) return;
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (stored === null || typeof stored !== "object" || Array.isArray(stored)) throw new Error("not an object");
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      this.logger.error({ err, aside }, "settings file unreadable, setting it aside and using defaults");
      renameSync(this.file, aside);
      return;
    }
    const next = clone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    for (const name of SECTION_NAMES) {
      if (stored[name] === undefined) continue;
      const merged = { ...(DEFAULT_SETTINGS[name] as object), ...(stored[name] as object) };
      const parsed = sectionSchemas[name].safeParse(merged);
      if (parsed.success) next[name] = parsed.data;
      else this.logger.warn({ section: name, problem: describeIssues(parsed.error, name) }, "invalid stored settings, using defaults for this section");
    }
    this.settings = next as unknown as Settings;
  }

  get(): Settings {
    return clone(this.settings);
  }

  section<K extends SectionName>(name: K): Settings[K] {
    return clone(this.settings[name]);
  }

  /**
   * Applies a partial update to one section. The patch is validated field by field (unknown keys rejected),
   * merged with the current values, and the merged section is validated again (e.g. emaFast < emaSlow).
   * Throws AppError(400) and changes nothing when invalid.
   */
  update<K extends SectionName>(name: K, patch: unknown): Settings[K] {
    const patchResult = patchSchemas[name].safeParse(patch);
    if (!patchResult.success) throw new AppError(400, "VALIDATION_ERROR", describeIssues(patchResult.error, name));
    const merged = { ...(this.settings[name] as object), ...(patchResult.data as object) };
    const full = sectionSchemas[name].safeParse(merged);
    if (!full.success) throw new AppError(400, "VALIDATION_ERROR", describeIssues(full.error, name));

    this.settings = { ...this.settings, [name]: full.data };
    void this.persist();
    const change: SettingsChange = { section: name, at: Date.now() };
    this.emit("changed", change);
    return clone(full.data) as Settings[K];
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.settings, null, 2);
    const tmp = `${this.file}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file);
      })
      .catch((err) => this.logger.error({ err }, "failed to persist settings"));
    return this.writeChain;
  }
}

/** Feeds the signal engine from the settings store, so edits apply to the very next candle with no restart. */
export class StoreSignalSettings implements SignalSettingsProvider {
  constructor(private readonly store: SettingsStore) {}

  get(): SignalSettings {
    const s = this.store.get();
    return { ...DEFAULT_SIGNAL_SETTINGS, enabled: true, enabledSymbols: s.symbols.enabled, ...s.signals };
  }
}

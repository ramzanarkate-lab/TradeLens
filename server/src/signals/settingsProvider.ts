import { DEFAULT_SIGNAL_SETTINGS, type SignalSettings } from "../config/signalDefaults.js";

/** The engine reads settings through this interface so the Phase 7 settings module can replace the constant defaults. */
export interface SignalSettingsProvider {
  get(): SignalSettings;
}

/** Fixed settings (defaults, optionally overridden). */
export class StaticSignalSettings implements SignalSettingsProvider {
  private readonly value: SignalSettings;

  constructor(overrides: Partial<SignalSettings> = {}) {
    this.value = { ...DEFAULT_SIGNAL_SETTINGS, ...overrides };
  }

  get(): SignalSettings {
    return this.value;
  }
}

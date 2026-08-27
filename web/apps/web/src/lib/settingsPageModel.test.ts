import { describe, expect, it } from "vitest";
import {
  INITIAL_SETTINGS_LOADS,
  SOURCE_UPDATE_INTERVAL_OPTIONS,
  settingsResourceSummary,
  type SettingsResourceLoad,
} from "./settingsPageModel";

function load(overrides: Partial<SettingsResourceLoad>): SettingsResourceLoad {
  return { loading: false, loaded: false, error: null, ...overrides };
}

describe("SOURCE_UPDATE_INTERVAL_OPTIONS", () => {
  it("offers manual, hourly, daily, and weekly choices", () => {
    expect(SOURCE_UPDATE_INTERVAL_OPTIONS.map((option) => option.value)).toEqual([
      "0",
      "1",
      "6",
      "24",
      "168",
    ]);
  });
});

describe("settingsResourceSummary", () => {
  it("marks resources ready only when the engine is ready and the resource can be used", () => {
    const summary = settingsResourceSummary("ready", {
      ...INITIAL_SETTINGS_LOADS,
      filaments: load({ loaded: true }),
      githubPat: load({ error: "failed" }),
    });

    expect(summary.ready.filaments).toBe(true);
    expect(summary.ready.githubPat).toBe(false);
    expect(summary.display.githubPat).toBe("initial-error");
    expect(summary.recoveryToolsReady).toBe(true);
  });

  it("keeps loaded resources usable with a background error", () => {
    const summary = settingsResourceSummary("ready", {
      ...INITIAL_SETTINGS_LOADS,
      discord: load({ loaded: true, error: "refresh failed" }),
    });

    expect(summary.ready.discord).toBe(true);
    expect(summary.display.discord).toBe("background-error");
  });

  it("blocks settings and recovery tools while the engine is offline", () => {
    const summary = settingsResourceSummary("offline", {
      ...INITIAL_SETTINGS_LOADS,
      sourceUpdates: load({ loaded: true }),
    });

    expect(summary.ready.sourceUpdates).toBe(false);
    expect(summary.recoveryToolsReady).toBe(false);
  });
});

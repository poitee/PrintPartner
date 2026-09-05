import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_UPDATE_INTERVAL_HOURS,
  parseSourceMonitoringUpdate,
  readStoredSourceUpdateIntervalHours,
} from "./source-monitoring-settings.js";

describe("source monitoring settings", () => {
  it("accepts disabled or bounded whole-hour schedules", () => {
    expect(parseSourceMonitoringUpdate({ interval_hours: 0 })).toEqual({
      kind: "valid",
      update: { intervalHours: 0 },
    });
    expect(parseSourceMonitoringUpdate({ interval_hours: 1 })).toEqual({
      kind: "valid",
      update: { intervalHours: 1 },
    });
    expect(parseSourceMonitoringUpdate({ interval_hours: 168 })).toEqual({
      kind: "valid",
      update: { intervalHours: 168 },
    });
    expect(parseSourceMonitoringUpdate({ auto_sync_updates: false })).toEqual({
      kind: "valid",
      update: { autoSyncUpdates: false },
    });
  });

  it.each([-1, 0.000001, 1.5, 169, Number.NaN, Number.POSITIVE_INFINITY, "1", null])(
    "rejects an unsafe interval value of %s",
    (intervalHours) => {
      expect(parseSourceMonitoringUpdate({ interval_hours: intervalHours })).toEqual({
        kind: "invalid",
        detail: "interval_hours must be 0 or a whole number from 1 through 168",
      });
    },
  );

  it("rejects malformed request bodies and automatic sync values", () => {
    expect(parseSourceMonitoringUpdate(null)).toEqual({
      kind: "invalid",
      detail: "request body must be an object",
    });
    expect(parseSourceMonitoringUpdate({ auto_sync_updates: "yes" })).toEqual({
      kind: "invalid",
      detail: "auto_sync_updates must be a boolean",
    });
  });

  it("uses the default for unsafe legacy values read from storage", () => {
    expect(readStoredSourceUpdateIntervalHours(null)).toBe(DEFAULT_SOURCE_UPDATE_INTERVAL_HOURS);
    expect(readStoredSourceUpdateIntervalHours("0.000001")).toBe(
      DEFAULT_SOURCE_UPDATE_INTERVAL_HOURS,
    );
    expect(readStoredSourceUpdateIntervalHours("not-a-number")).toBe(
      DEFAULT_SOURCE_UPDATE_INTERVAL_HOURS,
    );
    expect(readStoredSourceUpdateIntervalHours("0")).toBe(0);
    expect(readStoredSourceUpdateIntervalHours("168")).toBe(168);
  });
});

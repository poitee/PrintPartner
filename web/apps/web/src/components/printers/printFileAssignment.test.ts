import { describe, expect, it } from "vitest";
import type { PrinterStorageEntry } from "@print-partner/contracts";
import {
  chosenBuildId,
  requiredUnitToken,
  sortStorageEntries,
  storageCrumbs,
  validatePrintFileAssignment,
} from "./printFileAssignment";

describe("requiredUnitToken", () => {
  it("spells a Required unit as its part and index", () => {
    expect(requiredUnitToken({ part_id: 412, unit_index: 0 })).toBe("412:0");
  });
});

describe("chosenBuildId", () => {
  it("reads a chosen Build", () => {
    expect(chosenBuildId("7")).toBe(7);
  });

  it("treats an unmade choice as no Build", () => {
    expect(chosenBuildId("")).toBeNull();
    expect(chosenBuildId("0")).toBeNull();
    expect(chosenBuildId("-3")).toBeNull();
    expect(chosenBuildId("1.5")).toBeNull();
    expect(chosenBuildId("seven")).toBeNull();
  });
});

describe("validatePrintFileAssignment", () => {
  it("passes once a Build is chosen", () => {
    expect(
      validatePrintFileAssignment({ buildId: 7, confirmedUnitCount: 0, completed: false }),
    ).toEqual([]);
  });

  it("names the Build field when no Build is chosen", () => {
    expect(
      validatePrintFileAssignment({ buildId: null, confirmedUnitCount: 2, completed: false }),
    ).toEqual([{ field: "build", message: "Choose the Build this print belongs to" }]);
  });

  it("refuses to send a finished print with nothing to check off", () => {
    const errors = validatePrintFileAssignment({
      buildId: 7,
      confirmedUnitCount: 0,
      completed: true,
    });
    expect(errors.map((error) => error.field)).toEqual(["units"]);
  });

  it("reports every problem at once, so the summary is complete", () => {
    const errors = validatePrintFileAssignment({
      buildId: null,
      confirmedUnitCount: 0,
      completed: true,
    });
    expect(errors.map((error) => error.field)).toEqual(["build", "units"]);
  });
});

describe("storageCrumbs", () => {
  it("gives the root a single crumb", () => {
    expect(storageCrumbs("")).toEqual([{ label: "Printer storage", path: "" }]);
  });

  it("keeps one click back to the root from any depth", () => {
    expect(storageCrumbs("jobs/voron/plates")).toEqual([
      { label: "Printer storage", path: "" },
      { label: "jobs", path: "jobs" },
      { label: "voron", path: "jobs/voron" },
      { label: "plates", path: "jobs/voron/plates" },
    ]);
  });

  it("ignores empty segments", () => {
    expect(storageCrumbs("jobs//voron")).toEqual([
      { label: "Printer storage", path: "" },
      { label: "jobs", path: "jobs" },
      { label: "voron", path: "jobs/voron" },
    ]);
  });
});

describe("sortStorageEntries", () => {
  it("puts folders first, then the newest file", () => {
    const entries: PrinterStorageEntry[] = [
      { kind: "file", path: "old.gcode", name: "old.gcode", modified_at: "2026-01-01T00:00:00Z" },
      { kind: "directory", path: "voron", name: "voron" },
      { kind: "file", path: "new.gcode", name: "new.gcode", modified_at: "2026-08-01T00:00:00Z" },
      { kind: "directory", path: "archive", name: "archive" },
    ];

    expect(sortStorageEntries(entries).map((entry) => entry.name)).toEqual([
      "archive",
      "voron",
      "new.gcode",
      "old.gcode",
    ]);
  });

  it("sorts a file with no reported date last rather than first", () => {
    const entries: PrinterStorageEntry[] = [
      { kind: "file", path: "unknown.gcode", name: "unknown.gcode" },
      { kind: "file", path: "dated.gcode", name: "dated.gcode", modified_at: "2026-01-01T00:00:00Z" },
    ];

    expect(sortStorageEntries(entries).map((entry) => entry.name)).toEqual([
      "dated.gcode",
      "unknown.gcode",
    ]);
  });

  it("leaves the caller's array alone", () => {
    const entries: PrinterStorageEntry[] = [
      { kind: "file", path: "b.gcode", name: "b.gcode" },
      { kind: "directory", path: "a", name: "a" },
    ];
    sortStorageEntries(entries);
    expect(entries[0].name).toBe("b.gcode");
  });
});

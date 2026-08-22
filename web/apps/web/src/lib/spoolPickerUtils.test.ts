import { describe, expect, it } from "vitest";
import {
  filterFilamentSpools,
  formatSpoolOptionLabel,
  partSpoolPickerVisibility,
} from "./spoolPickerUtils";
import type { SpoolmanSpoolRow } from "../api/engine";

const spool = (id: number, filament_id: number, remaining_weight: number): SpoolmanSpoolRow => ({
  id,
  filament_id,
  remaining_weight,
});

describe("filterFilamentSpools", () => {
  it("includes zero-weight spools", () => {
    expect(
      filterFilamentSpools(
        [spool(1, 7, 100), spool(2, 7, 0), spool(3, 8, 50)],
        7,
      ).map((s) => s.id),
    ).toEqual([1, 2]);
  });
});

describe("formatSpoolOptionLabel", () => {
  it("marks empty spools", () => {
    expect(formatSpoolOptionLabel(spool(3, 7, 0))).toContain("(empty)");
  });
});

describe("partSpoolPickerVisibility", () => {
  it("hides non-spoolman filaments", () => {
    expect(
      partSpoolPickerVisibility("bambu:pla:black", []),
    ).toEqual({ show: false, reason: "not_spoolman_filament" });
  });

  it("shows empty state when no spools match", () => {
    expect(
      partSpoolPickerVisibility("spoolman:abc:filament:7", [spool(1, 8, 100)]),
    ).toEqual({ show: true, kind: "empty", reason: "no_matching_spools" });
  });

  it("shows loading state while spools fetch is in flight", () => {
    expect(
      partSpoolPickerVisibility("spoolman:abc:filament:7", [], { spoolsLoading: true }),
    ).toEqual({ show: true, kind: "loading", reason: "spools_loading" });
  });

  it("shows picker when spools exist including empty weight", () => {
    const result = partSpoolPickerVisibility("spoolman:abc:filament:7", [
      spool(1, 7, 0),
      spool(2, 7, 120),
    ]);
    expect(result).toMatchObject({ show: true, kind: "picker" });
    if (result.show && result.kind === "picker") {
      expect(result.spools.map((s) => s.id)).toEqual([1, 2]);
    }
  });
});

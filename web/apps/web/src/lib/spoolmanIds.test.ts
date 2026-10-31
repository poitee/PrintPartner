import { describe, expect, it } from "vitest";
import {
  buildSpoolmanSpoolId,
  hasSpoolmanAssignment,
  hasSpoolmanColorOrigin,
  parseSpoolmanFilamentId,
  parseSpoolmanSpoolId,
} from "./spoolmanIds";

describe("spoolmanIds", () => {
  it.each(["catalog:red", "custom:red"])("keeps %s color origin separate from its attached spool", (filamentColorId) => {
    const assignment = { filament_color_id: filamentColorId, spoolman_spool_id: "spoolman:abc:spool:3" };
    expect(hasSpoolmanAssignment(assignment)).toBe(true);
    expect(hasSpoolmanColorOrigin(assignment)).toBe(false);
  });

  it.each([undefined, null, "", "   ", " spoolman:abc:filament:7 "])("recognizes Spoolman color enrichment for color ID %s", (filamentColorId) => {
    expect(hasSpoolmanColorOrigin({ filament_color_id: filamentColorId, spoolman_spool_id: "spoolman:abc:spool:3" })).toBe(true);
  });

  it.each(["5", " spoolman:abc:spool:3 "])("recognizes a spool-only assignment: %s", (spoolmanSpoolId) => {
    expect(hasSpoolmanAssignment({ filament_color_id: "catalog:red", spoolman_spool_id: spoolmanSpoolId })).toBe(true);
  });

  it.each([undefined, null, "", "   "])("ignores an empty spool assignment: %s", (spoolmanSpoolId) => {
    expect(hasSpoolmanAssignment({ filament_color_id: "catalog:red", spoolman_spool_id: spoolmanSpoolId })).toBe(false);
  });

  it("parses filament and spool refs", () => {
    expect(parseSpoolmanFilamentId("spoolman:abc:filament:7")).toEqual({
      integrationId: "abc",
      filamentId: 7,
    });
    const spoolRef = buildSpoolmanSpoolId("abc", 3);
    expect(spoolRef).toBe("spoolman:abc:spool:3");
    expect(parseSpoolmanSpoolId(spoolRef)).toEqual({ integrationId: "abc", spoolId: 3 });
  });
});

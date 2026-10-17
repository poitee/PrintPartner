import { describe, expect, it } from "vitest";
import {
  buildSpoolmanSpoolId,
  hasSpoolmanAssignment,
  parseSpoolmanFilamentId,
  parseSpoolmanSpoolId,
} from "./spoolmanIds";

describe("spoolmanIds", () => {
  it.each(["5", " spoolman:abc:spool:3 "])("recognizes a spool-only assignment: %s", (spoolman_spool_id) => {
    expect(hasSpoolmanAssignment({ filament_color_id: "catalog:red", spoolman_spool_id })).toBe(true);
  });

  it.each([undefined, null, "", "   "])("ignores an empty spool assignment: %s", (spoolman_spool_id) => {
    expect(hasSpoolmanAssignment({ filament_color_id: "catalog:red", spoolman_spool_id })).toBe(false);
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

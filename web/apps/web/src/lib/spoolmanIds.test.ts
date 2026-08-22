import { describe, expect, it } from "vitest";
import {
  buildSpoolmanSpoolId,
  parseSpoolmanFilamentId,
  parseSpoolmanSpoolId,
} from "./spoolmanIds";

describe("spoolmanIds", () => {
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

import { describe, expect, it } from "vitest";
import { completeRoleAssignment } from "./plan-role-assignment-model.js";

describe("completeRoleAssignment", () => {
  it("maps route body fields to a catalog color assignment", () => {
    expect(completeRoleAssignment({ filament_color_id: "pla-black" })).toEqual({
      color: { kind: "catalog", colorId: "pla-black" },
      spoolmanSpoolId: null,
    });
  });

  it("maps custom hex and spool fields", () => {
    expect(
      completeRoleAssignment({ filament_custom_hex: "#abcdef", spoolman_spool_id: "42" }),
    ).toEqual({
      color: { kind: "custom", hex: "#abcdef" },
      spoolmanSpoolId: "42",
    });
  });

  it("clears assignment when all fields are empty", () => {
    expect(completeRoleAssignment({})).toEqual({
      color: { kind: "unset" },
      spoolmanSpoolId: null,
    });
  });
});

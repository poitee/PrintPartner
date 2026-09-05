import { describe, expect, it } from "vitest";
import { productionSetupCommandSchema } from "./production-setup.js";

describe("productionSetupCommandSchema", () => {
  it.each([
    {
      kind: "set_preferred_slicer_instance",
      preferred_slicer_instance_id: "orca-main",
    },
    {
      kind: "set_selection",
      selection: { mode: "custom", selected_unit_tokens: ["unit:a:1"] },
    },
    {
      kind: "replace_printer_assignments",
      printer_assignments: [{ token: "unit:a:1", printer_id: "printer-one" }],
    },
    { kind: "set_route", route: "plates" },
    { kind: "set_route", route: null },
    {
      kind: "replace_rules",
      rules: [{ id: "rule-one", enabled: true, kind: "separate_by", field: "color" }],
    },
  ])("accepts $kind", (command) => {
    expect(productionSetupCommandSchema.parse(command)).toEqual(command);
  });

  it.each([
    {},
    { kind: "set_route" },
    { kind: "set_route", route: "plate" },
    { kind: "set_route", route: "plates", selection: { mode: "all_incomplete" } },
    { kind: "set_selection", selection: { mode: "custom", selected_unit_tokens: [""] } },
    { kind: "replace_printer_assignments", printer_assignments: [{ token: "unit:a:1" }] },
    { kind: "replace_rules", rules: [{ id: "rule-one", enabled: true, kind: "unknown" }] },
  ])("rejects an invalid or multi-field command", (command) => {
    expect(productionSetupCommandSchema.safeParse(command).success).toBe(false);
  });
});

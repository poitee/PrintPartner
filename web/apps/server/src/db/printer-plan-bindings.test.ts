import { describe, expect, it } from "vitest";
import { parsePrinterPlanBindings, upsertPrinterPlanBinding } from "./printer-plan-bindings.js";

describe("printer Plan bindings", () => {
  it("parses empty settings as no bindings", () => {
    expect(parsePrinterPlanBindings(null)).toEqual([]);
    expect(parsePrinterPlanBindings(" ")).toEqual([]);
  });

  it("parses valid bindings", () => {
    expect(
      parsePrinterPlanBindings(
        JSON.stringify([
          { integration_id: "host-1", profile_id: 12, updated_at: "2026-08-25T20:00:00.000Z" },
          { integration_id: "host-2", profile_id: null, updated_at: "2026-08-25T20:01:00.000Z" },
        ]),
      ),
    ).toEqual([
      { integration_id: "host-1", profile_id: 12, updated_at: "2026-08-25T20:00:00.000Z" },
      { integration_id: "host-2", profile_id: null, updated_at: "2026-08-25T20:01:00.000Z" },
    ]);
  });

  it("rejects corrupt bindings", () => {
    expect(() => parsePrinterPlanBindings("not json")).toThrow("Printer Plan bindings are corrupt");
    expect(() => parsePrinterPlanBindings(JSON.stringify({ integration_id: "host" }))).toThrow(
      "Printer Plan bindings are corrupt",
    );
    expect(() =>
      parsePrinterPlanBindings(JSON.stringify([{ integration_id: "host", profile_id: 0, updated_at: "now" }])),
    ).toThrow("Printer Plan bindings are corrupt");
  });

  it("upserts by integration id", () => {
    const original = [
      { integration_id: "host-1", profile_id: 1, updated_at: "old" },
      { integration_id: "host-2", profile_id: 2, updated_at: "old" },
    ];

    expect(
      upsertPrinterPlanBinding(original, {
        integration_id: "host-1",
        profile_id: 3,
        updated_at: "new",
      }),
    ).toEqual([
      { integration_id: "host-1", profile_id: 3, updated_at: "new" },
      { integration_id: "host-2", profile_id: 2, updated_at: "old" },
    ]);
    expect(
      upsertPrinterPlanBinding(original, {
        integration_id: "host-3",
        profile_id: null,
        updated_at: "new",
      }),
    ).toHaveLength(3);
  });
});

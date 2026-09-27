import { describe, expect, it } from "vitest";
import { planHeaderSubtitle } from "./planWarnings";
import type { ProfileSummary, } from "@print-partner/contracts";

describe("planHeaderSubtitle", () => {
  it("joins name, sources, parts", () => {
    const profile = { id: 1, name: "Voron Trident 300", order_number: null, special_request: null, part_count: 359, accepted_progress: { kind: "ready", remaining_units: 0, total_units: 359 }, build_stale: false, freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-08-20T12:00:00.000Z" }, archived_at: null, last_used_at: null } satisfies ProfileSummary;
    expect(planHeaderSubtitle({ profile, sourceCount: 4, partCount: 359 })).toBe(
      "Voron Trident 300 · 4 sources · 359 parts",
    );
  });
});

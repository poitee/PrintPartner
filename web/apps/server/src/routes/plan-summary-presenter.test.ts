import { describe, expect, it } from "vitest";
import type {
  AcceptedProfileProgress,
  AcceptedProfileSummary,
  ProfileHeader,
} from "../db/repository.js";
import { toLegacyProfileSummary, toProfileSummary } from "./plan-summary-presenter.js";

const header: ProfileHeader = {
  id: 17,
  name: "Trident",
  order_number: "PP-17",
  special_request: "Call before printing",
  part_count: 3,
  build_stale: false,
  freshness: {
    status: "untracked",
    accepted_input_set_id: null,
    accepted_at: null,
    reasons: [{ kind: "no_accepted_inputs" }],
  },
  archived_at: null,
  last_used_at: "2026-08-21T12:00:00.000Z",
};

function summary(progress: AcceptedProfileProgress): AcceptedProfileSummary {
  return { header, progress };
}

describe("Plan summary presenters", () => {
  it("projects every accepted Progress state without exposing integrity codes", () => {
    expect(
      toProfileSummary(summary({ kind: "ready", totalUnits: 8, remainingUnits: 3 })),
    ).toEqual({
      ...header,
      accepted_progress: { kind: "ready", total_units: 8, remaining_units: 3 },
    });
    expect(toProfileSummary(summary({ kind: "empty" }))).toEqual({
      ...header,
      accepted_progress: { kind: "empty" },
    });
    expect(
      toProfileSummary(
        summary({ kind: "unavailable", reason: "compatibility_dirty" }),
      ),
    ).toEqual({
      ...header,
      accepted_progress: { kind: "unavailable", reason: "compatibility_dirty" },
    });
    expect(
      toProfileSummary(summary({ kind: "unavailable", reason: "uninitialized" })),
    ).toEqual({
      ...header,
      accepted_progress: { kind: "unavailable", reason: "uninitialized" },
    });
    expect(
      toProfileSummary(summary({ kind: "integrity_failure", code: "revision_digest" })),
    ).toEqual({
      ...header,
      accepted_progress: { kind: "unavailable", reason: "integrity" },
    });
    expect(toProfileSummary(summary({ kind: "concurrent_update" }))).toEqual({
      ...header,
      accepted_progress: { kind: "unavailable", reason: "concurrent_update" },
    });
  });

  it("maps ready and true empty states to legacy numeric summaries", () => {
    expect(
      toLegacyProfileSummary(
        summary({ kind: "ready", totalUnits: 8, remainingUnits: 3 }),
      ),
    ).toEqual({
      kind: "ready",
      profile: { ...header, total_units: 8, remaining_units: 3 },
    });
    expect(toLegacyProfileSummary(summary({ kind: "empty" }))).toEqual({
      kind: "ready",
      profile: { ...header, total_units: 0, remaining_units: 0 },
    });
  });

  it("returns typed legacy failures for every unavailable state", () => {
    expect(
      toLegacyProfileSummary(
        summary({ kind: "unavailable", reason: "compatibility_dirty" }),
      ),
    ).toEqual({
      kind: "unavailable",
      failure: { kind: "unavailable", reason: "compatibility_dirty" },
    });
    expect(
      toLegacyProfileSummary(summary({ kind: "unavailable", reason: "uninitialized" })),
    ).toEqual({
      kind: "unavailable",
      failure: { kind: "unavailable", reason: "uninitialized" },
    });
    expect(
      toLegacyProfileSummary(summary({ kind: "integrity_failure", code: "progress" })),
    ).toEqual({
      kind: "unavailable",
      failure: { kind: "integrity_failure", code: "progress" },
    });
    expect(toLegacyProfileSummary(summary({ kind: "concurrent_update" }))).toEqual({
      kind: "unavailable",
      failure: { kind: "concurrent_update" },
    });
  });
});

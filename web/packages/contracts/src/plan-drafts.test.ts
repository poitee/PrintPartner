import { describe, expect, it } from "vitest";
import {
  parseApplyPlanDraftRequest,
  parseAbandonPlanDraftRequest,
  parseAcceptedProgressImportRequest,
  parseAcceptedProgressImportResponse,
  parseEditPlanDraftPartsRequest,
  parsePlanDraftWorkspace,
  parseReconcilePlanDraftRequest,
  parseRebasePlanDraftRequest,
} from "./plan-drafts.js";

const digest = "a".repeat(64);

describe("Plan draft contracts", () => {
  it("parses a strict saved draft workspace", () => {
    expect(parsePlanDraftWorkspace({
      profile_id: 7,
      draft: {
        draft_id: 11,
        state: "open",
        lifecycle_version: 0,
        snapshot_digest: digest,
        base: { revision_id: 3, plan_version: 2 },
      },
      parts: [],
      diff: { base_is_current: true, added: [], removed: [], changed: [] },
      reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
    })).toMatchObject({ profile_id: 7, draft: { draft_id: 11 } });
  });

  it("rejects unsafe decisions and mismatched empty accepted bases", () => {
    expect(() => parseEditPlanDraftPartsRequest({
      expected_snapshot_digest: digest,
      decision: { kind: "set_quantity_override", draft_part_ids: [1], value: 10_001 },
    })).toThrow();
    expect(() => parseApplyPlanDraftRequest({
      expected_snapshot_digest: digest,
      expected_lifecycle_version: 0,
      expected_base: { revision_id: null, plan_version: 1 },
    })).toThrow();
  });

  it("parses one atomic batch of mixed Part decisions", () => {
    expect(parseEditPlanDraftPartsRequest({
      expected_snapshot_digest: digest,
      decisions: [
        { kind: "set_quantity_override", draft_part_ids: [1, 2], value: 3 },
        { kind: "set_included", draft_part_ids: [2], value: false },
      ],
    })).toMatchObject({ decisions: [{ kind: "set_quantity_override" }, { kind: "set_included" }] });

    expect(() => parseEditPlanDraftPartsRequest({
      expected_snapshot_digest: digest,
      decision: { kind: "set_included", draft_part_ids: [1], value: true },
      decisions: [{ kind: "set_included", draft_part_ids: [1], value: false }],
    })).toThrow();
  });

  it("rejects duplicate targets while allowing one inclusion and quantity edit per Part", () => {
    expect(() => parseEditPlanDraftPartsRequest({
      expected_snapshot_digest: digest,
      decisions: [
        { kind: "set_included", draft_part_ids: [1], value: true },
        { kind: "set_included", draft_part_ids: [1, 2], value: false },
      ],
    })).toThrow();
    expect(() => parseEditPlanDraftPartsRequest({
      expected_snapshot_digest: digest,
      decision: { kind: "set_quantity_override", draft_part_ids: [1, 1], value: 3 },
    })).toThrow();
    expect(parseEditPlanDraftPartsRequest({
      expected_snapshot_digest: digest,
      decisions: [
        { kind: "set_quantity_override", draft_part_ids: [1], value: 3 },
        { kind: "set_included", draft_part_ids: [1], value: false },
      ],
    })).toMatchObject({ decisions: [{ kind: "set_quantity_override" }, { kind: "set_included" }] });
  });

  it("bounds reconciliation decisions and rejects duplicate targets", () => {
    expect(parseReconcilePlanDraftRequest({
      expected_snapshot_digest: digest,
      decisions: [],
    })).toEqual({ expected_snapshot_digest: digest, decisions: [] });
    expect(() => parseReconcilePlanDraftRequest({
      expected_snapshot_digest: digest,
      decisions: [
        { kind: "replace", target_draft_part_id: 1 },
        { kind: "replace", target_draft_part_id: 1 },
      ],
    })).toThrow();
    expect(parsePlanDraftWorkspace({
      profile_id: 7,
      draft: {
        draft_id: 11,
        state: "open",
        lifecycle_version: 0,
        snapshot_digest: digest,
        base: { revision_id: 3, plan_version: 2 },
      },
      parts: [],
      diff: { base_is_current: true, added: [], removed: [], changed: [] },
      reconciliation: { kind: "unresolved", conflicts: [] },
    })).toMatchObject({ reconciliation: { kind: "unresolved", conflicts: [] } });
  });

  it("parses lifecycle recovery and rejects duplicate Progress import targets", () => {
    expect(parseAbandonPlanDraftRequest({ expected_lifecycle_version: 2 })).toEqual({
      expected_lifecycle_version: 2,
    });
    expect(parseRebasePlanDraftRequest({
      expected_source_lifecycle_version: 3,
      expected_source_snapshot_digest: digest,
    })).toEqual({
      expected_source_lifecycle_version: 3,
      expected_source_snapshot_digest: digest,
    });
    const expected = {
      profile_id: 7,
      plan_version: 2,
      plan_revision_id: 3,
      plan_revision_digest: digest,
      required_unit_mapping_digest: "b".repeat(64),
    };
    expect(parseAcceptedProgressImportRequest({
      expected,
      rows: [{ part_id: 4, printed_count: 2 }],
    })).toEqual({ expected, rows: [{ part_id: 4, printed_count: 2 }] });
    expect(() => parseAcceptedProgressImportRequest({
      expected,
      rows: [
        { part_id: 4, printed_count: 1 },
        { part_id: 4, printed_count: 2 },
      ],
    })).toThrow();
    expect(parseAcceptedProgressImportResponse({ updated_parts: 1 })).toEqual({
      updated_parts: 1,
    });
    expect(() => parseAcceptedProgressImportResponse({
      updated_parts: 1,
      private_path: "/secret",
    })).toThrow();
  });
});

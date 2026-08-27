import { describe, expect, it, vi } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import type {
  PlanDraftIdentity,
  PlanDraftWorkspace,
} from "@print-partner/contracts";
import {
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  fetchPlanDraftWorkspace,
  importAcceptedPrintedCounts,
  listPlanDrafts,
  rebasePlanDraft,
  recomputePlanDraft,
  reconcilePlanDraft,
} from "./planDrafts";

const basis = {
  profile_id: 7,
  plan_version: 1,
  plan_revision_id: 3,
  plan_revision_digest: "a".repeat(64),
  required_unit_mapping_digest: "b".repeat(64),
};

const draft: PlanDraftIdentity = {
  draft_id: 9,
  state: "open",
  lifecycle_version: 0,
  snapshot_digest: "a".repeat(64),
  base: { revision_id: 3, plan_version: 1 },
};

const workspace: PlanDraftWorkspace = {
  profile_id: 7,
  draft,
  parts: [],
  diff: { base_is_current: true, added: [], removed: [], changed: [] },
  reconciliation: {
    kind: "ready",
    reused_units: 0,
    new_units: 0,
    surplus_units: 0,
  },
};

const http = createEndpointTestHttp();

describe("plan draft endpoints", () => {
  it("creates an idempotency key when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    http.respond(jsonResponse(workspace));

    await expect(recomputePlanDraft(7)).resolves.toEqual(workspace);

    expect(
      new Headers(http.calls[0]?.[1]?.headers).get("Idempotency-Key"),
    ).toMatch(/^idem-/);
    expect(http.requestJson(0)).toEqual({ apply_manifest: true });
  });

  it("lists and reads drafts", async () => {
    http
      .respond(jsonResponse({ drafts: [draft] }))
      .respond(jsonResponse(workspace));

    await expect(listPlanDrafts(7)).resolves.toEqual([draft]);
    await expect(fetchPlanDraftWorkspace(7, 9)).resolves.toEqual(workspace);
  });

  it("edits, reconciles, applies, abandons, rebases, and imports progress", async () => {
    http
      .respond(jsonResponse(workspace))
      .respond(jsonResponse(workspace))
      .respond(
        jsonResponse({
          profile_id: 7,
          draft_id: 9,
          revision_id: 4,
          plan_version: 2,
          draft_lifecycle_version: 1,
          revision_digest: "c".repeat(64),
          required_unit_mapping_digest: "d".repeat(64),
          applied_at: "2026-08-25T22:00:00.000Z",
        }),
      )
      .respond(jsonResponse(draft))
      .respond(jsonResponse(workspace))
      .respond(jsonResponse({ updated_parts: 2 }));

    await editPlanDraftParts({
      profileId: 7,
      draftId: 9,
      expectedSnapshotDigest: "digest",
      decisions: [],
    });
    await reconcilePlanDraft({
      profileId: 7,
      draftId: 9,
      expectedSnapshotDigest: "digest",
      decisions: [],
    });
    await applyPlanDraft(workspace, { remapCheckoffLinks: true });
    await abandonPlanDraft(7, draft);
    await rebasePlanDraft(7, draft);
    await importAcceptedPrintedCounts({
      profileId: 7,
      expected: basis,
      rows: [{ part_id: 1, printed_count: 2 }],
    });

    expect(http.requestJson(0)).toEqual({
      expected_snapshot_digest: "digest",
      decisions: [],
    });
    expect(http.requestJson(1)).toEqual({
      expected_snapshot_digest: "digest",
      decisions: [],
    });
    expect(http.requestJson(2)).toMatchObject({ remap_checkoff_links: true });
    expect(http.requestJson(3)).toEqual({ expected_lifecycle_version: 0 });
    expect(http.requestJson(4)).toEqual({
      expected_source_lifecycle_version: 0,
      expected_source_snapshot_digest: draft.snapshot_digest,
    });
    expect(http.requestJson(5)).toEqual({
      expected: basis,
      rows: [{ part_id: 1, printed_count: 2 }],
    });
  });
});

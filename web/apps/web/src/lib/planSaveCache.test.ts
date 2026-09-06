import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { PlanDraftIdentity } from "@print-partner/contracts";
import type { SavePlanChoicesResponse } from "../api/endpoints/planDrafts";
import { capturePlanSaveCache, hydratePlanSave, includedPlanReview } from "./planSaveCache";
import { queryKeys } from "../queries/keys";

function saved(version: number): SavePlanChoicesResponse {
  return {
    receipt: { profile_id: 7, draft_id: 9, revision_id: version + 2, plan_version: version,
      draft_lifecycle_version: 1, revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-09-06T00:00:00Z" },
    review: { profile_id: 7, accepted_basis: { profile_id: 7, plan_revision_id: version + 2, plan_version: version,
      plan_revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64) },
      plan_name: `Revision ${version}`, layers: [], part_groups: [], issues: [], has_blockers: false,
      totals: { included_parts: 0, total_print_units: 0, by_role: {}, by_filament: {} } },
    profile: { id: 7, name: `Revision ${version}`, part_count: 0, order_number: null, special_request: null,
      accepted_progress: { kind: "empty" }, build_stale: false,
      freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-09-06T00:00:00Z" },
      archived_at: null, last_used_at: null },
    closed_draft_ids: [9],
  };
}

function progressReview(version: number, completed: boolean) {
  const review = saved(version).review;
  review.part_groups = [{ folder: "frame", source_layer: "base", parts: [{
    id: 42, match_key: "part.stl", relative_path: "part.stl", filename: "part.stl", source_layer: "base",
    status: "ok", role: "primary", requirement: null, option_group_id: null, included: true,
    filament_color_id: null, filament_display: "Unset", quantity_auto: 1, quantity_override: null, quantity_effective: 1,
    printed_count: Number(completed), print_units: [completed], assembled_units: [completed], missing: !completed,
  }] }];
  return review;
}

describe("confirmed Plan cache", () => {
  it("preserves same-version progress that changed after a save was sent", async () => {
    const client = new QueryClient();
    const response = saved(2);
    response.review = progressReview(2, false);
    client.setQueryData(queryKeys.planReview(7, false), response.review);
    const observed = capturePlanSaveCache(client, 7);
    const progressed = progressReview(2, true);
    client.setQueryData(queryKeys.planReview(7, false), progressed);
    await hydratePlanSave(client, response, observed);
    expect(client.getQueryData(queryKeys.planReview(7, false))).toEqual(progressed);
    expect(client.getQueryState(queryKeys.planReview(7, false))?.isInvalidated).toBe(true);
    client.clear();
  });

  it("refreshes active Review after progress overlaps publication of a newer Plan version", async () => {
    const client = new QueryClient();
    const latest = progressReview(2, true);
    let resolve!: (review: typeof latest) => void;
    const queryFn = vi.fn(() => new Promise<typeof latest>((done) => { resolve = done; }));
    const key = queryKeys.planReview(7, false);
    const observer = new QueryObserver(client, { queryKey: key, queryFn, initialData: progressReview(1, false), staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    const observed = capturePlanSaveCache(client, 7);
    client.setQueryData(key, progressReview(1, true));
    await hydratePlanSave(client, { ...saved(2), review: progressReview(2, false) }, observed);
    expect(client.getQueryData<typeof latest>(key)?.accepted_basis?.plan_version).toBe(2);
    expect(queryFn).toHaveBeenCalledOnce();
    resolve(latest);
    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual(latest));
    unsubscribe();
    client.clear();
  });

  it("protects updates that land while query cancellation is yielding", async () => {
    const client = new QueryClient();
    const key = queryKeys.planReview(7, false);
    client.setQueryData(key, progressReview(2, false));
    const observed = capturePlanSaveCache(client, 7);
    const originalCancel = client.cancelQueries.bind(client);
    vi.spyOn(client, "cancelQueries").mockImplementation(async (...args) => {
      await originalCancel(...args);
      client.setQueryData(key, progressReview(2, true));
    });
    await hydratePlanSave(client, { ...saved(2), review: progressReview(2, false) }, observed);
    expect(client.getQueryData(key)).toEqual(progressReview(2, true));
    client.clear();
  });

  it("preserves an edited profile while still updating this Build when only another Build changed", async () => {
    const client = new QueryClient();
    const initial = saved(1).profile;
    const other = { ...initial, id: 8, name: "Other" };
    client.setQueryData(queryKeys.profiles, [initial, other]);
    const observed = capturePlanSaveCache(client, 7);
    const renamedOther = { ...other, name: "Renamed other" };
    client.setQueryData(queryKeys.profiles, [initial, renamedOther]);
    await hydratePlanSave(client, saved(2), observed);
    expect(client.getQueryData(queryKeys.profiles)).toEqual([saved(2).profile, renamedOther]);
    const nextObserved = capturePlanSaveCache(client, 7);
    const renamed = { ...saved(2).profile, name: "Renamed target" };
    client.setQueryData(queryKeys.profiles, [renamed, renamedOther]);
    client.setQueryData(queryKeys.profile(7), renamed);
    await hydratePlanSave(client, saved(2), nextObserved);
    expect(client.getQueryData(queryKeys.profile(7))).toEqual(renamed);
    expect(client.getQueryData(queryKeys.profiles)).toEqual([renamed, renamedOther]);
    client.clear();
  });

  it("does not cancel a profile read for another Build", async () => {
    const client = new QueryClient();
    let resolve!: (profile: SavePlanChoicesResponse["profile"]) => void;
    const other = { ...saved(1).profile, id: 8 };
    const pending = client.fetchQuery({ queryKey: queryKeys.profile(8),
      queryFn: () => new Promise<typeof other>((done) => { resolve = done; }) });
    await hydratePlanSave(client, saved(2), capturePlanSaveCache(client, 7));
    resolve(other);
    await expect(pending).resolves.toEqual(other);
    client.clear();
  });
  it("keeps a newer confirmed Review and profile when an earlier receipt arrives late", async () => {
    const client = new QueryClient();
    await hydratePlanSave(client, saved(4), capturePlanSaveCache(client, 7));
    await hydratePlanSave(client, saved(2), capturePlanSaveCache(client, 7));
    expect(client.getQueryData(queryKeys.planReview(7, true))).toEqual(saved(4).review);
    expect(client.getQueryData(queryKeys.planReview(7, false))).toEqual(saved(4).review);
    expect(client.getQueryData(queryKeys.profile(7))).toEqual(saved(4).profile);
    expect(client.getQueryData(queryKeys.profiles)).toBeUndefined();
    client.clear();
  });

  it("removes only returned closed drafts and preserves another user's saved draft", async () => {
    const client = new QueryClient();
    const draft: PlanDraftIdentity = { draft_id: 9, state: "open", lifecycle_version: 0,
      snapshot_digest: "a".repeat(64), base: { revision_id: 3, plan_version: 1 } };
    const other = { ...draft, draft_id: 10 };
    client.setQueryData(queryKeys.planDrafts(7), [draft, other]);
    client.setQueryData(queryKeys.planDraft(7, 9), { draft });
    client.setQueryData(queryKeys.planDraft(7, 10), { draft: other });
    await hydratePlanSave(client, saved(2), capturePlanSaveCache(client, 7));
    expect(client.getQueryData(queryKeys.planDrafts(7))).toEqual([other]);
    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toBeUndefined();
    expect(client.getQueryData(queryKeys.planDraft(7, 10))).toEqual({ draft: other });
    client.clear();
  });

  it("keeps authoritative totals and issues while filtering excluded groups", () => {
    const review = saved(2).review;
    review.issues = [{ code: "no_included_parts", severity: "warning", message: "Choose files" }];
    review.part_groups = [{ folder: "empty", source_layer: "base", parts: [] }];
    const included = includedPlanReview(review);
    expect(included.part_groups).toEqual([]);
    expect(included.issues).toBe(review.issues);
    expect(included.totals).toBe(review.totals);
  });
});

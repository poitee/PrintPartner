// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type PlanDraftWorkspace,
  type PlanFeatures,
} from "@print-partner/contracts";
import { EngineHttpError } from "../api/engineTransport";
import {
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  fetchPlanDraftWorkspace,
  listPlanDrafts,
  recomputePlanDraft,
  rebasePlanDraft,
  savePlanChoices,
  type SavePlanChoicesResponse,
} from "../api/endpoints/planDrafts";
import type { PlanReview } from "../api/endpoints/planManifests";
import { queryKeys } from "../queries/keys";
import { usePlanDraftWorkspaceQuery } from "../queries/planDraft";
import { usePlanReviewQuery } from "../queries/planReview";
import { WORKING_PLAN_CHANGED_MESSAGE } from "../lib/workingPlanChanged";
import {
  resetAuxiliarySaveIntentForTests,
  retainFailedAuxiliarySave,
} from "../lib/planAuxiliarySaveIntent";
import {
  PlanWorkspaceProvider,
  usePlanWorkspace,
} from "./PlanWorkspaceContext";

const acceptedReview: PlanReview = {
  profile_id: 7,
  accepted_basis: null,
  plan_name: "Accepted Plan",
  layers: [],
  totals: {
    included_parts: 0,
    total_print_units: 0,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [],
};

const savedWorkspace: PlanDraftWorkspace = {
  profile_id: 7,
  draft: {
    draft_id: 9,
    state: "open",
    lifecycle_version: 0,
    snapshot_digest: "a".repeat(64),
    base: { revision_id: 3, plan_version: 1 },
  },
  parts: [
    {
      draft_part_id: 17,
      base_revision_part_id: 42,
      part_key: "frame/bracket.stl",
      filename: "bracket.stl",
      relative_path: "frame/bracket.stl",
      source_layer: "base:Voron",
      role: "structural",
      quantity_inferred: 1,
      quantity_override: null,
      quantity_effective: 1,
      included: true,
    },
  ],
  diff: { base_is_current: true, added: [], removed: [], changed: [] },
  reconciliation: {
    kind: "ready",
    reused_units: 0,
    new_units: 0,
    surplus_units: 0,
  },
};

/** The Plan row the user clicks — identity the draft is resolved against. */
const planRow = {
  id: 42,
  match_key: "frame/bracket.stl",
  relative_path: "frame/bracket.stl",
  source_layer: "base:Voron",
  filename: "bracket.stl",
};

function savedChoices(quantity = 1, planVersion = 2): SavePlanChoicesResponse {
  return {
    receipt: {
      profile_id: 7, draft_id: 9, revision_id: planVersion + 2, plan_version: planVersion,
      draft_lifecycle_version: 1, revision_digest: "c".repeat(64),
      required_unit_mapping_digest: "d".repeat(64), applied_at: "2026-08-21T12:00:00.000Z",
    },
    review: {
      ...acceptedReview,
      accepted_basis: { profile_id: 7, plan_revision_id: planVersion + 2, plan_version: planVersion,
        plan_revision_digest: "c".repeat(64), required_unit_mapping_digest: "d".repeat(64) },
      part_groups: [{ folder: "frame", source_layer: "base:Voron", parts: [{
        ...planRow, id: 52, included: false, status: "unchanged", role: "structural",
        requirement: null, option_group_id: null, filament_color_id: null, filament_display: "Unassigned",
        quantity_auto: 1, quantity_override: quantity, quantity_effective: quantity,
        printed_count: 0, print_units: [], missing: true,
      }] }],
    },
    profile: { id: 7, name: "Accepted Plan", order_number: null, special_request: null,
      part_count: 1, accepted_progress: { kind: "ready", total_units: 0, remaining_units: 0 },
      build_stale: false, freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-08-21T12:00:00.000Z" },
      archived_at: null, last_used_at: null },
    closed_draft_ids: [9],
  };
}

const replacementWorkspace: PlanDraftWorkspace = {
  ...savedWorkspace,
  draft: { ...savedWorkspace.draft, snapshot_digest: "b".repeat(64) },
};

const otherWorkspace: PlanDraftWorkspace = {
  ...savedWorkspace,
  profile_id: 8,
  draft: {
    ...savedWorkspace.draft,
    draft_id: 19,
    snapshot_digest: "e".repeat(64),
  },
  parts: savedWorkspace.parts.map((part) => ({
    ...part,
    draft_part_id: 27,
  })),
};

const draftQueryState = vi.hoisted(() => ({
  hasOpenDraft: true,
  hasOtherWorkspace: false,
  hasWorkspace: true,
  /** Models a click landing before GET /plans/:id/drafts has resolved. */
  listPending: false,
  workspace: null as PlanDraftWorkspace | null,
}));

const profileSelectionState = vi.hoisted<{
  selectedProfileId: number | null;
}>(() => ({ selectedProfileId: 7 }));

const healthQueryState = vi.hoisted<{ capabilities: string[] }>(() => ({ capabilities: [] }));

/** A disabled review query reports isLoading false. This models that empty result. */
const reviewQueryState = vi.hoisted(() => ({ empty: false }));

const editedWorkspace: PlanDraftWorkspace = {
  ...replacementWorkspace,
  draft: { ...replacementWorkspace.draft, snapshot_digest: "c".repeat(64) },
  parts: replacementWorkspace.parts.map((part) => ({
    ...part,
    included: false,
  })),
};

vi.mock("../api/endpoints/planDrafts", () => ({
  applyPlanDraft: vi.fn(),
  abandonPlanDraft: vi.fn(),
  editPlanDraftParts: vi.fn(),
  fetchPlanDraftWorkspace: vi.fn(),
  listPlanDrafts: vi.fn(),
  reconcilePlanDraft: vi.fn(),
  recomputePlanDraft: vi.fn(),
  rebasePlanDraft: vi.fn(),
  savePlanChoices: vi.fn(),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true } }),
}));

vi.mock("../queries/health", () => ({
  useHealthQuery: () => ({
    data: { ok: true, capabilities: healthQueryState.capabilities },
    isSuccess: true,
  }),
}));

vi.mock("./ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: profileSelectionState.selectedProfileId,
  }),
}));

vi.mock("../queries/planReview", () => ({
  usePlanReviewQuery: vi.fn(() => ({
    data: reviewQueryState.empty ? null : acceptedReview,
    isLoading: false,
    error: null,
  })),
  usePatchPartMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartProgressMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartAssembledMutation: () => ({ mutateAsync: vi.fn() }),
  invalidatePlanReview: (client: QueryClient, profileId: number) =>
    client.invalidateQueries({
      queryKey: queryKeys.planReview(profileId, false),
    }),
}));

const profileQueries = vi.hoisted(() => ({
  refreshProfileSummary: vi.fn(),
  invalidateProfiles: vi.fn(),
}));

vi.mock("../queries/profiles", () => ({
  refreshProfileSummary: (client: QueryClient, profileId: number) => {
    profileQueries.refreshProfileSummary(profileId);
    return client.invalidateQueries({ queryKey: queryKeys.profiles });
  },
  invalidateProfiles: (client: QueryClient) => {
    profileQueries.invalidateProfiles();
    return client.invalidateQueries({ queryKey: queryKeys.profiles });
  },
}));

vi.mock("../queries/planDraft", () => ({
  usePlanDraftListQuery: (profileId: number | null) => {
    const workspace =
      profileId === savedWorkspace.profile_id
        ? savedWorkspace
        : profileId === otherWorkspace.profile_id &&
            draftQueryState.hasOtherWorkspace
          ? otherWorkspace
          : null;
    return {
      data:
        workspace &&
        draftQueryState.hasOpenDraft &&
        !draftQueryState.listPending
          ? [workspace.draft]
          : undefined,
      isLoading: draftQueryState.listPending,
      error: null,
    };
  },
  usePlanDraftWorkspaceQuery: vi.fn(
    (profileId: number | null, draftId: number | null) => {
      const workspace =
        profileId === savedWorkspace.profile_id
          ? (draftQueryState.workspace ?? savedWorkspace)
          : profileId === otherWorkspace.profile_id &&
              draftQueryState.hasOtherWorkspace
            ? otherWorkspace
            : null;
      return {
        data:
          workspace &&
          draftQueryState.hasWorkspace &&
          draftId === workspace.draft.draft_id
            ? workspace
            : undefined,
        isLoading: false,
        error: null,
      };
    },
  ),
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <PlanWorkspaceProvider>{children}</PlanWorkspaceProvider>
      </QueryClientProvider>
    );
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetAuxiliarySaveIntentForTests();
});

beforeEach(() => {
  healthQueryState.capabilities = [];
  reviewQueryState.empty = false;
  profileSelectionState.selectedProfileId = 7;
  draftQueryState.hasOpenDraft = true;
  draftQueryState.hasOtherWorkspace = false;
  draftQueryState.hasWorkspace = true;
  draftQueryState.listPending = false;
  draftQueryState.workspace = null;
  vi.mocked(savePlanChoices).mockReset();
  vi.mocked(savePlanChoices).mockResolvedValue(savedChoices());
  vi.mocked(listPlanDrafts).mockImplementation(async () =>
    draftQueryState.hasOpenDraft ? [savedWorkspace.draft] : [],
  );
  vi.mocked(fetchPlanDraftWorkspace).mockImplementation(
    async () => draftQueryState.workspace ?? savedWorkspace,
  );
  // Default rebuild result: a brand-new draft, so a wrong rebuild shows up as a
  // failed assertion rather than an unrelated crash.
  vi.mocked(recomputePlanDraft).mockResolvedValue({
    ...savedWorkspace,
    draft: {
      ...savedWorkspace.draft,
      draft_id: 11,
      snapshot_digest: "c".repeat(64),
    },
  });
  vi.mocked(editPlanDraftParts).mockReset();
  vi.mocked(editPlanDraftParts).mockResolvedValue({
    ...savedWorkspace,
    draft: { ...savedWorkspace.draft, snapshot_digest: "b".repeat(64) },
    parts: savedWorkspace.parts.map((part) => ({ ...part, included: false })),
  });
  vi.mocked(applyPlanDraft).mockResolvedValue({
    profile_id: 7,
    draft_id: 9,
    revision_id: 4,
    plan_version: 2,
    draft_lifecycle_version: 1,
    revision_digest: "c".repeat(64),
    required_unit_mapping_digest: "d".repeat(64),
    applied_at: "2026-08-21T12:00:00.000Z",
  });
  vi.mocked(abandonPlanDraft).mockResolvedValue({
    ...savedWorkspace.draft,
    state: "abandoned",
    lifecycle_version: 1,
  });
  vi.mocked(rebasePlanDraft).mockResolvedValue({
    ...savedWorkspace,
    draft: {
      ...savedWorkspace.draft,
      draft_id: 10,
      base: { revision_id: 4, plan_version: 2 },
    },
  });
});

describe("PlanWorkspaceProvider workspace read selection", () => {
  it("workspace_rebuild_read_keeps_revision_identity", async () => {
    healthQueryState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    expect(vi.mocked(usePlanReviewQuery)).toHaveBeenLastCalledWith(7, expect.objectContaining({
      revisionId: savedWorkspace.draft.base.revision_id,
    }));
  });

  it("workspace_flag_off_preserves_query_path", async () => {
    healthQueryState.capabilities = [];
    renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(vi.mocked(usePlanReviewQuery)).toHaveBeenCalled());
    for (const call of vi.mocked(usePlanReviewQuery).mock.calls) {
      expect(call[1]?.revisionId).toBeUndefined();
    }
  });

  it("workspace_rebuild_read_stays_loading_until_the_draft_is_known", () => {
    healthQueryState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    draftQueryState.listPending = true;
    reviewQueryState.empty = true;
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.error).toBeNull();
  });

  it("workspace_rebuild_read_waits_for_the_open_draft", () => {
    healthQueryState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    draftQueryState.hasWorkspace = false;
    reviewQueryState.empty = true;
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    expect(vi.mocked(usePlanReviewQuery).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.review).toBeNull();
  });

  it("workspace_rebuild_read_skips_a_stale_draft_revision", async () => {
    healthQueryState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    draftQueryState.workspace = {
      ...savedWorkspace,
      diff: { ...savedWorkspace.diff, base_is_current: false },
    };
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    const enabledCalls = vi.mocked(usePlanReviewQuery).mock.calls.filter((call) => call[1]?.enabled !== false);
    expect(enabledCalls.length).toBeGreaterThan(0);
    for (const call of enabledCalls) expect(call[1]?.revisionId).toBeUndefined();
  });

  it("workspace_rebuild_apply_drops_pinned_review_slots", async () => {
    healthQueryState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const acceptedKey = queryKeys.planReview(7, false, true);
    const pinnedKey = queryKeys.planReview(7, false, true, savedWorkspace.draft.base.revision_id);
    const refreshReview = vi.fn().mockResolvedValue(acceptedReview);
    const pinnedFetch = vi.fn(async () => {
      throw new Error("The Build Review response belongs to a different Plan revision");
    });
    client.setQueryDefaults(acceptedKey, { queryFn: refreshReview });
    client.setQueryDefaults(pinnedKey, { queryFn: pinnedFetch });
    client.setQueryData(acceptedKey, acceptedReview);
    client.setQueryData(pinnedKey, acceptedReview);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    await act(async () => {
      await hook.result.current.applyActivePlanDraft();
    });
    expect(hook.result.current.draftError).toBeNull();
    expect(refreshReview).toHaveBeenCalledOnce();
    expect(pinnedFetch).not.toHaveBeenCalled();
    expect(client.getQueryState(pinnedKey)).toBeUndefined();
  });
});

describe("PlanWorkspaceProvider saved draft lifecycle", () => {
  it("prepares a first Plan without a publish action", async () => {
    draftQueryState.hasOpenDraft = false;
    draftQueryState.hasWorkspace = false;
    const firstWorkspace: PlanDraftWorkspace = {
      ...savedWorkspace,
      draft: { ...savedWorkspace.draft, draft_id: 11, base: { revision_id: null, plan_version: 0 } },
    };
    vi.mocked(recomputePlanDraft).mockResolvedValue(firstWorkspace);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await act(async () => { await hook.result.current.preparePlan(); });
    expect(applyPlanDraft).toHaveBeenCalledWith(firstWorkspace, { remapCheckoffLinks: true });
    expect(hook.result.current.saving).toBe(false);
    expect(hook.result.current.draftError).toBeNull();
  });

  it("does not create a new saved version when reopening an unchanged Plan", async () => {
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());
    await act(async () => { await hook.result.current.preparePlan(); });
    expect(abandonPlanDraft).toHaveBeenCalledWith(7, savedWorkspace.draft);
    expect(applyPlanDraft).not.toHaveBeenCalled();
  });

  it("keeps failed autosave edits and names the linked print", async () => {
    vi.mocked(savePlanChoices).mockRejectedValueOnce(new EngineHttpError("Cannot move print", 422, {
      code: "checkoff_remap_unsafe", unmappable: [{ filename: "bracket.stl", reason: "removed" }],
    }));
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());
    await act(async () => { await expect(hook.result.current.setIncluded(planRow, false)).rejects.toThrow("bracket.stl"); });
    expect([...hook.result.current.pendingFileChoices.values()][0]?.included).toBe(false);
    expect(hook.result.current.draftError).toContain("Restore the affected file");
    expect(abandonPlanDraft).not.toHaveBeenCalled();
  });

  it("saves folder choices with one request and hydrates confirmed state without refetching", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());
    await act(async () => { await hook.result.current.setFilesIncluded([planRow], false); });
    expect(savePlanChoices).toHaveBeenCalledOnce();
    expect(editPlanDraftParts).not.toHaveBeenCalled();
    expect(applyPlanDraft).not.toHaveBeenCalled();
    expect(listPlanDrafts).not.toHaveBeenCalled();
    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, true))?.accepted_basis?.plan_version).toBe(2);
    expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, false))?.accepted_basis?.plan_version).toBe(2);
    expect(hook.result.current.saving).toBe(false);
  });

  it("saves a manifest batch from an accepted Plan without creating a Working Plan", async () => {
    draftQueryState.hasOpenDraft = false;
    draftQueryState.hasWorkspace = false;
    const client = new QueryClient();
    client.setQueryData(queryKeys.planReview(7, true), savedChoices().review);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.savePlanPartChanges([
        { kind: "set_quantity", part: planRow, value: 2 },
        { kind: "set_included", part: planRow, value: false },
      ]);
    });

    expect(savePlanChoices).toHaveBeenCalledOnce();
    expect(savePlanChoices).toHaveBeenCalledWith(7, expect.objectContaining({
      expected_draft: null,
      remap_checkoff_links: true,
      decisions: [
        {
          kind: "set_quantity_override",
          target: {
            part_key: planRow.match_key,
            relative_path: planRow.relative_path,
            source_layer: planRow.source_layer,
          },
          value: 2,
        },
        {
          kind: "set_included",
          target: {
            part_key: planRow.match_key,
            relative_path: planRow.relative_path,
            source_layer: planRow.source_layer,
          },
          value: false,
        },
      ],
    }), expect.any(String));
    expect(editPlanDraftParts).not.toHaveBeenCalled();
    expect(applyPlanDraft).not.toHaveBeenCalled();
    expect(recomputePlanDraft).not.toHaveBeenCalled();
  });

  it.each([
    { allowed: false, includeExcluded: true },
    { allowed: false, includeExcluded: false },
    { allowed: true, includeExcluded: true },
    { allowed: true, includeExcluded: false },
  ])("saves the current access review basis when allowed=$allowed and includeExcluded=$includeExcluded", async ({ allowed, includeExcluded }) => {
    draftQueryState.hasOpenDraft = false;
    draftQueryState.hasWorkspace = false;
    healthQueryState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(queryKeys.health, { ok: true, capabilities: healthQueryState.capabilities });
    client.setQueryData<PlanFeatures>(queryKeys.planFeatures(7), {
      profile_id: 7,
      overrides: { spoolman: allowed },
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: allowed, source: "plan" },
      },
    });
    client.setQueryData(queryKeys.planReview(7, true, !allowed), savedChoices(1, 2).review);
    client.setQueryData(queryKeys.planReview(7, false, !allowed), savedChoices(1, 2).review);
    client.setQueryData(queryKeys.planReview(7, includeExcluded, allowed), savedChoices(1, 5).review);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.savePlanPartChanges([
        { kind: "set_included", part: planRow, value: false },
      ]);
    });

    expect(savePlanChoices).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({
      expected_base: { revision_id: 7, plan_version: 5 },
      expected_draft: null,
      decisions: [{
        kind: "set_included",
        target: {
          part_key: "frame/bracket.stl",
          relative_path: "frame/bracket.stl",
          source_layer: "base:Voron",
        },
        value: false,
      }],
    }), expect.any(String));
  });

  it.each([true, false])("uses the newest same-access review when includeExcluded=%s", async (includeExcluded) => {
    draftQueryState.hasOpenDraft = false;
    draftQueryState.hasWorkspace = false;
    const client = new QueryClient();
    client.setQueryData(queryKeys.planReview(7, !includeExcluded, true), savedChoices(1, 2).review);
    await client.invalidateQueries({ queryKey: queryKeys.planReview(7, !includeExcluded, true), exact: true });
    client.setQueryData(queryKeys.planReview(7, includeExcluded, true), savedChoices(1, 5).review);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.savePlanPartChanges([{ kind: "set_included", part: planRow, value: false }]);
    });

    expect(savePlanChoices).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({
      expected_base: { revision_id: 7, plan_version: 5 },
    }), expect.any(String));
  });

  it.each([true, false])("reads current access when a queued save runs after allowed=%s changes", async (allowed) => {
    draftQueryState.hasOpenDraft = false;
    draftQueryState.hasWorkspace = false;
    healthQueryState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(queryKeys.health, { ok: true, capabilities: healthQueryState.capabilities });
    const features: PlanFeatures = {
      profile_id: 7,
      overrides: { spoolman: allowed },
      effective: {
        farm: { enabled: false, source: "default" },
        orders: { enabled: false, source: "default" },
        bambu: { enabled: false, source: "default" },
        spoolman: { enabled: allowed, source: "plan" },
      },
    };
    client.setQueryData(queryKeys.planFeatures(7), features);
    client.setQueryData(queryKeys.planReview(7, true, allowed), savedChoices(1, 2).review);
    const first = deferred<SavePlanChoicesResponse>();
    vi.mocked(savePlanChoices).mockReturnValueOnce(first.promise);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    let edits: Promise<void>[] = [];
    act(() => {
      edits = [
        hook.result.current.savePlanPartChanges([{ kind: "set_included", part: planRow, value: false }]),
        hook.result.current.savePlanPartChanges([{ kind: "set_included", part: planRow, value: true }]),
      ];
    });
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledOnce());
    await act(async () => {
      client.setQueryData(queryKeys.planFeatures(7), {
        ...features, effective: { ...features.effective, spoolman: { enabled: !allowed, source: "plan" } },
      });
      client.setQueryData(queryKeys.planReview(7, true, !allowed), savedChoices(1, 5).review);
      first.resolve(savedChoices(1, 3));
      await Promise.all(edits);
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(2);
    expect(savePlanChoices).toHaveBeenLastCalledWith(7, expect.objectContaining({
      expected_base: { revision_id: 7, plan_version: 5 },
    }), expect.any(String));
  });

  it("saves inclusion from the accepted Plan without creating a draft in the browser", async () => {
    const freshWorkspace: PlanDraftWorkspace = {
      ...savedWorkspace,
      draft: {
        ...savedWorkspace.draft,
        draft_id: 11,
        snapshot_digest: "c".repeat(64),
      },
      parts: [
        {
          draft_part_id: 17,
          base_revision_part_id: 42,
          part_key: "frame/bracket.stl",
          filename: "bracket.stl",
          relative_path: "frame/bracket.stl",
          source_layer: "base:Voron",
          role: "structural",
          quantity_inferred: 1,
          quantity_override: null,
          quantity_effective: 1,
          included: true,
        },
      ],
    };
    draftQueryState.hasOpenDraft = false;
    draftQueryState.hasWorkspace = false;
    vi.mocked(recomputePlanDraft).mockResolvedValue(freshWorkspace);
    vi.mocked(editPlanDraftParts).mockResolvedValue({
      ...freshWorkspace,
      parts: [{ ...freshWorkspace.parts[0]!, included: false }],
    });

    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(savePlanChoices).toHaveBeenCalledWith(7, expect.objectContaining({
      expected_draft: null,
      decisions: [{ kind: "set_included", target: { part_key: planRow.match_key, relative_path: planRow.relative_path, source_layer: planRow.source_layer }, value: false }],
    }), expect.any(String));
  });

  it("loads the persisted open draft instead of rebuilding when its workspace GET has not resolved", async () => {
    // A reload leaves the open draft on disk while GET /drafts/:id is still in
    // flight. Editing must PATCH that draft, never rebuild it from Sources.
    draftQueryState.hasWorkspace = false;
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(fetchPlanDraftWorkspace).not.toHaveBeenCalled();
    expect(savePlanChoices).toHaveBeenCalledWith(7,
      expect.objectContaining({ expected_draft: savedWorkspace.draft }), expect.any(String));
  });

  it("recovers the persisted draft when a click lands before the draft list loads", async () => {
    draftQueryState.hasWorkspace = false;
    draftQueryState.listPending = true;
    vi.mocked(savePlanChoices).mockRejectedValueOnce(new EngineHttpError("Draft changed", 409, {
      code: "draft_changed", workspace: savedWorkspace,
    }));
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(listPlanDrafts).not.toHaveBeenCalled();
    expect(savePlanChoices).toHaveBeenCalledTimes(2);
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[1].expected_draft).toBeNull();
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].expected_draft).toEqual(savedWorkspace.draft);
  });

  it("does not rebuild when the cached draft list is stale and empty", async () => {
    draftQueryState.hasWorkspace = false;
    const client = new QueryClient();
    client.setQueryData(queryKeys.planDrafts(7), []);
    vi.mocked(savePlanChoices).mockRejectedValueOnce(new EngineHttpError("Draft changed", 409, {
      code: "draft_changed", workspace: savedWorkspace,
    }));
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(listPlanDrafts).not.toHaveBeenCalled();
    expect(savePlanChoices).toHaveBeenLastCalledWith(7,
      expect.objectContaining({ expected_draft: savedWorkspace.draft }), expect.any(String));
  });

  it("clears a previous Plan-sheet error when a later editActivePlanDraft succeeds", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    vi.mocked(editPlanDraftParts).mockRejectedValueOnce(new Error("disk full"));

    await act(async () => {
      await expect(
        hook.result.current.editActivePlanDraft([
          { kind: "set_included", draft_part_ids: [17], value: false },
        ]),
      ).rejects.toThrow("disk full");
    });
    expect(hook.result.current.draftError).toBe("disk full");

    vi.mocked(editPlanDraftParts).mockResolvedValueOnce(editedWorkspace);
    await act(async () => {
      await hook.result.current.editActivePlanDraft([
        { kind: "set_included", draft_part_ids: [17], value: false },
      ]);
    });
    expect(hook.result.current.draftError).toBeNull();
  });

  it("retries one inclusion edit after replacing a stale draft", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    vi.mocked(savePlanChoices)
      .mockRejectedValueOnce(
        new EngineHttpError("Draft changed", 409, {
          code: "draft_changed",
          workspace: replacementWorkspace,
        }),
      )
      .mockResolvedValueOnce(savedChoices());

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(savePlanChoices).toHaveBeenCalledTimes(2);
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[1].expected_draft?.snapshot_digest).toBe("a".repeat(64));
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].expected_draft?.snapshot_digest).toBe("b".repeat(64));
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[2]).not.toBe(vi.mocked(savePlanChoices).mock.calls[1]?.[2]);
    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toBeUndefined();
    expect(hook.result.current.draftError).toBeNull();
  });

  it("serializes rapid quantity edits against each saved snapshot", async () => {
    const first = deferred<SavePlanChoicesResponse>();
    const second = deferred<SavePlanChoicesResponse>();
    const third = deferred<SavePlanChoicesResponse>();
    vi.mocked(savePlanChoices)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );

    let edits!: Promise<void>[];
    act(() => {
      edits = [
        hook.result.current.setQuantity(planRow, (quantity) => quantity + 1),
        hook.result.current.setQuantity(planRow, (quantity) => quantity + 1),
        hook.result.current.setQuantity(planRow, (quantity) => quantity + 1),
      ];
    });

    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(1));
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[1].decisions[0]?.value).toBe(2);

    await act(async () => {
      first.resolve(savedChoices(2, 2));
      await first.promise;
    });
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(2));
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].decisions[0]?.value).toBe(3);
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].expected_base.plan_version).toBe(2);

    await act(async () => {
      second.resolve(savedChoices(3, 3));
      await second.promise;
    });
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledTimes(3));
    expect(vi.mocked(savePlanChoices).mock.calls[2]?.[1].decisions[0]?.value).toBe(4);
    expect(vi.mocked(savePlanChoices).mock.calls[2]?.[1].expected_base.plan_version).toBe(3);

    await act(async () => {
      third.resolve(savedChoices(4, 4));
      await Promise.all(edits);
    });
    expect(applyPlanDraft).not.toHaveBeenCalled();
    expect(client.getQueryData<PlanReview>(queryKeys.planReview(7, true))?.part_groups[0]?.parts[0]?.quantity_effective).toBe(4);
  });

  it.each(["inputs_changed", "base_changed"])("recovers %s during the combined save without a manual retry", async (code) => {
    const changed = { ...savedWorkspace, diff: { ...savedWorkspace.diff, base_is_current: false } };
    vi.mocked(savePlanChoices).mockRejectedValueOnce(new EngineHttpError("Changed", 409, {
      code, workspace: code === "base_changed" ? changed : savedWorkspace,
    })).mockResolvedValueOnce({ ...savedChoices(1, 3), closed_draft_ids: [10] });
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());
    await act(async () => { await hook.result.current.setIncluded(planRow, false); });
    expect(savePlanChoices).toHaveBeenCalledTimes(2);
    expect(rebasePlanDraft).toHaveBeenCalledWith(7, savedWorkspace.draft);
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1].expected_draft?.draft_id).toBe(10);
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[2]).not.toBe(vi.mocked(savePlanChoices).mock.calls[1]?.[2]);
    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(hook.result.current.draftError).toBeNull();
  });

  it("failed_save_retains_original_request", async () => {
    const definitive = new EngineHttpError("Quantity is no longer valid", 422);
    vi.mocked(savePlanChoices)
      .mockRejectedValueOnce(definitive)
      .mockResolvedValueOnce(savedChoices(2, 2));
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());

    await act(async () => {
      await expect(hook.result.current.setQuantity(planRow, 2)).rejects.toThrow(
        "Quantity is no longer valid",
      );
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(1);
    const originalRequest = vi.mocked(savePlanChoices).mock.calls[0]?.[1];
    expect(originalRequest?.decisions).toEqual([
      expect.objectContaining({
        kind: "set_quantity_override",
        target: {
          part_key: planRow.match_key,
          relative_path: planRow.relative_path,
          source_layer: planRow.source_layer,
        },
        value: 2,
      }),
    ]);

    await act(async () => {
      await hook.result.current.retryPlanSave();
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(2);
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[1]).toEqual(originalRequest);
    expect(hook.result.current.draftError).toBeNull();
  });

  it("failed_save_retry_reuses_operation_identity", async () => {
    const definitive = new EngineHttpError("Quantity is no longer valid", 422);
    vi.mocked(savePlanChoices)
      .mockRejectedValueOnce(definitive)
      .mockResolvedValueOnce(savedChoices(2, 2));
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());

    await act(async () => {
      await expect(hook.result.current.setQuantity(planRow, 2)).rejects.toThrow(
        "Quantity is no longer valid",
      );
    });
    const retainedKey = vi.mocked(savePlanChoices).mock.calls[0]?.[2];
    expect(retainedKey).toEqual(expect.any(String));

    await act(async () => {
      await hook.result.current.retryPlanSave();
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(2);
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[2]).toBe(retainedKey);
    expect(hook.result.current.draftError).toBeNull();
  });

  it("preparePlan_does_not_resend_definitive_failed_ordinary_save", async () => {
    const definitive = new EngineHttpError("Quantity is no longer valid", 422);
    vi.mocked(savePlanChoices).mockRejectedValueOnce(definitive);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());

    await act(async () => {
      await expect(hook.result.current.setQuantity(planRow, 2)).rejects.toThrow(
        "Quantity is no longer valid",
      );
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(1);

    await act(async () => {
      await expect(hook.result.current.preparePlan()).rejects.toThrow(
        "Quantity is no longer valid",
      );
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(1);
    expect(hook.result.current.draftError).toBe("Quantity is no longer valid");
  });

  it("failed_save_definitive_apply_manifest_still_prepares", async () => {
    const definitive = new EngineHttpError("Quantity is no longer valid", 422);
    vi.mocked(savePlanChoices).mockRejectedValue(definitive);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());

    await act(async () => {
      await expect(hook.result.current.setQuantity(planRow, 2)).rejects.toThrow(
        "Quantity is no longer valid",
      );
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(1);
    const rejectedKey = vi.mocked(savePlanChoices).mock.calls[0]?.[2];

    await act(async () => {
      await hook.result.current.preparePlan({ applyManifest: true });
    });
    // applyManifest must reach prepare without resending the rejected payload, and must
    // consume the definitive snapshot so a later plain preparePlan does not stick it.
    expect(savePlanChoices).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePlanChoices).mock.calls[0]?.[2]).toBe(rejectedKey);
    expect(
      vi.mocked(applyPlanDraft).mock.calls.length +
        vi.mocked(abandonPlanDraft).mock.calls.length,
    ).toBeGreaterThan(0);
    expect(hook.result.current.draftError).toBeNull();

    const prepareCallsAfterApply =
      vi.mocked(applyPlanDraft).mock.calls.length +
      vi.mocked(abandonPlanDraft).mock.calls.length;
    await act(async () => {
      await hook.result.current.preparePlan();
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(applyPlanDraft).mock.calls.length +
        vi.mocked(abandonPlanDraft).mock.calls.length,
    ).toBeGreaterThan(prepareCallsAfterApply);
    expect(hook.result.current.draftError).toBeNull();
  });

  it("retry_with_failed_manifest_prepares_the_plan_once", async () => {
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());
    const prepareCalls = () =>
      vi.mocked(recomputePlanDraft).mock.calls.length +
      vi.mocked(applyPlanDraft).mock.calls.length +
      vi.mocked(abandonPlanDraft).mock.calls.length;
    const before = prepareCalls();
    let preparesBeforeManifestRetry: number | null = null;
    // Stands in for KitManifestOptions, whose retried PUT ends in preparePlan({ applyManifest: true }).
    retainFailedAuxiliarySave(7, "manifest", "offline", async () => {
      preparesBeforeManifestRetry = prepareCalls() - before;
      await hook.result.current.preparePlan({ applyManifest: true });
    });

    await act(async () => {
      await hook.result.current.retryPlanSave();
    });
    expect(preparesBeforeManifestRetry).toBe(0);
    expect(vi.mocked(recomputePlanDraft)).toHaveBeenLastCalledWith(7, { applyManifest: true });
    expect(hook.result.current.draftError).toBeNull();
  });

  it("failed_save_409_recovery_issues_new_operation_key", async () => {
    const definitive = new EngineHttpError("Quantity is no longer valid", 422);
    const changed = { ...savedWorkspace, diff: { ...savedWorkspace.diff, base_is_current: false } };
    vi.mocked(savePlanChoices)
      .mockRejectedValueOnce(definitive)
      .mockRejectedValueOnce(new EngineHttpError("Changed", 409, {
        code: "base_changed", workspace: changed,
      }))
      .mockResolvedValueOnce({ ...savedChoices(2, 3), closed_draft_ids: [10] });
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());

    await act(async () => {
      await expect(hook.result.current.setQuantity(planRow, 2)).rejects.toThrow(
        "Quantity is no longer valid",
      );
    });
    const retainedKey = vi.mocked(savePlanChoices).mock.calls[0]?.[2];
    expect(retainedKey).toEqual(expect.any(String));

    await act(async () => {
      await hook.result.current.retryPlanSave();
    });
    expect(savePlanChoices).toHaveBeenCalledTimes(3);
    expect(vi.mocked(savePlanChoices).mock.calls[1]?.[2]).toBe(retainedKey);
    expect(vi.mocked(savePlanChoices).mock.calls[2]?.[2]).not.toBe(retainedKey);
    expect(rebasePlanDraft).toHaveBeenCalled();
    expect(hook.result.current.draftError).toBeNull();
  });

  it("keeps a completed Build A edit out of Build B's active draft state", async () => {
    const edit = deferred<PlanDraftWorkspace>();
    vi.mocked(editPlanDraftParts).mockReturnValueOnce(edit.promise);
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );

    let editPromise: Promise<PlanDraftWorkspace> | null = null;
    act(() => {
      editPromise = hook.result.current.editActivePlanDraft([
        { kind: "set_included", draft_part_ids: [17], value: false },
      ]);
    });
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());

    profileSelectionState.selectedProfileId = 8;
    hook.rerender();
    await waitFor(() =>
      expect(vi.mocked(usePlanDraftWorkspaceQuery)).toHaveBeenLastCalledWith(
        8,
        null,
        true,
      ),
    );

    const pendingEdit = editPromise;
    if (!pendingEdit) throw new Error("Expected the Build A edit to be pending");
    await act(async () => {
      edit.resolve(editedWorkspace);
      await pendingEdit;
    });

    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toEqual(
      editedWorkspace,
    );
    expect(client.getQueryData(queryKeys.planDraft(8, 9))).toBeUndefined();
    expect(hook.result.current.draftWorkspace).toBeNull();
    expect(vi.mocked(usePlanDraftWorkspaceQuery)).not.toHaveBeenCalledWith(
      8,
      9,
      true,
    );
  });

  it("does not make Build B wait behind Build A's edit queue", async () => {
    const buildAEdit = deferred<PlanDraftWorkspace>();
    const editedOtherWorkspace: PlanDraftWorkspace = {
      ...otherWorkspace,
      draft: {
        ...otherWorkspace.draft,
        snapshot_digest: "f".repeat(64),
      },
      parts: otherWorkspace.parts.map((part) => ({
        ...part,
        included: false,
      })),
    };
    vi.mocked(editPlanDraftParts)
      .mockReturnValueOnce(buildAEdit.promise)
      .mockResolvedValueOnce(editedOtherWorkspace);
    draftQueryState.hasOtherWorkspace = true;
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );

    let buildAEditPromise: Promise<PlanDraftWorkspace> | null = null;
    act(() => {
      buildAEditPromise = hook.result.current.editActivePlanDraft([
        { kind: "set_included", draft_part_ids: [17], value: false },
      ]);
    });
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());

    profileSelectionState.selectedProfileId = 8;
    hook.rerender();
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(19),
    );

    let buildBEditPromise: Promise<PlanDraftWorkspace> | null = null;
    act(() => {
      buildBEditPromise = hook.result.current.editActivePlanDraft([
        { kind: "set_included", draft_part_ids: [27], value: false },
      ]);
    });
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledTimes(2));
    expect(editPlanDraftParts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ profileId: 8, draftId: 19 }),
    );

    const pendingBuildBEdit = buildBEditPromise;
    if (!pendingBuildBEdit)
      throw new Error("Expected the Build B edit to be pending");
    await act(async () => {
      await pendingBuildBEdit;
    });
    expect(client.getQueryData(queryKeys.planDraft(8, 19))).toEqual(
      editedOtherWorkspace,
    );

    const pendingBuildAEdit = buildAEditPromise;
    if (!pendingBuildAEdit)
      throw new Error("Expected the Build A edit to be pending");
    await act(async () => {
      buildAEdit.resolve(editedWorkspace);
      await pendingBuildAEdit;
    });
  });

  it("keeps Build A's late busy and error state out of Build B", async () => {
    const buildAEdit = deferred<SavePlanChoicesResponse>();
    vi.mocked(savePlanChoices).mockReturnValueOnce(buildAEdit.promise);
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );

    let buildAEditPromise: Promise<void> | null = null;
    act(() => {
      buildAEditPromise = hook.result.current.setIncluded(planRow, false);
    });
    await waitFor(() => expect(savePlanChoices).toHaveBeenCalledOnce());
    expect(hook.result.current.busyPartId).toBe(planRow.id);

    profileSelectionState.selectedProfileId = 8;
    hook.rerender();
    expect(hook.result.current.busyPartId).toBeNull();
    expect(hook.result.current.draftError).toBeNull();

    const pendingBuildAEdit = buildAEditPromise;
    if (!pendingBuildAEdit)
      throw new Error("Expected the Build A edit to be pending");
    await act(async () => {
      buildAEdit.reject(new EngineHttpError("Build A disk full", 422));
      await expect(pendingBuildAEdit).rejects.toThrow("Build A disk full");
    });

    expect(hook.result.current.busyPartId).toBeNull();
    expect(hook.result.current.draftError).toBeNull();
  });

  it("refetches the persisted open draft after each mount", async () => {
    const firstClient = new QueryClient();
    const first = renderHook(usePlanWorkspace, {
      wrapper: wrapper(firstClient),
    });
    await waitFor(() =>
      expect(first.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    first.unmount();

    const secondClient = new QueryClient();
    const second = renderHook(usePlanWorkspace, {
      wrapper: wrapper(secondClient),
    });
    await waitFor(() =>
      expect(second.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    expect(vi.mocked(usePlanDraftWorkspaceQuery)).toHaveBeenCalledWith(
      7,
      9,
      true,
    );
  });

  it("replaces the cached workspace on a stale edit and leaves accepted Review unchanged", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    vi.mocked(editPlanDraftParts).mockRejectedValue(
      new EngineHttpError("Draft changed", 409, {
        code: "draft_changed",
        workspace: replacementWorkspace,
      }),
    );

    await act(async () => {
      await expect(
        hook.result.current.editActivePlanDraft([
          { kind: "set_included", draft_part_ids: [1], value: false },
        ]),
      ).rejects.toThrow("Working Plan changed");
    });

    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toEqual(
      replacementWorkspace,
    );
    expect(hook.result.current.review).toBe(acceptedReview);
    expect(hook.result.current.draftError).toMatch(/Working Plan changed/i);
  });

  it("does not Apply implicitly and invalidates every accepted projection after explicit Apply", async () => {
    const client = new QueryClient();
    const refreshReview = vi.fn().mockResolvedValue(acceptedReview);
    client.setQueryDefaults(queryKeys.planReview(7, false), { queryFn: refreshReview });
    for (const key of [
      queryKeys.planReview(7, false),
      queryKeys.profiles,
      queryKeys.checkoff(7),
      queryKeys.acceptedPlateWorkspace(7),
      queryKeys.acceptedPlateExportJobs(7),
    ]) {
      client.setQueryData(key, {});
    }
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    expect(applyPlanDraft).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.applyActivePlanDraft();
    });

    expect(applyPlanDraft).toHaveBeenCalledWith(savedWorkspace, undefined);
    expect(refreshReview).toHaveBeenCalledOnce();
    expect(client.getQueryData(queryKeys.planReview(7, false))).toEqual(acceptedReview);
    expect(client.getQueryState(queryKeys.profiles)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.checkoff(7))?.isInvalidated).toBe(
      true,
    );
    expect(
      client.getQueryState(queryKeys.acceptedPlateWorkspace(7))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(queryKeys.acceptedPlateExportJobs(7))?.isInvalidated,
    ).toBe(true);
    await waitFor(() => expect(hook.result.current.draftWorkspace).toBeNull());
  });

  it("replaces a stale publication workspace so the next explicit retry uses current state", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    vi.mocked(applyPlanDraft)
      .mockRejectedValueOnce(
        new EngineHttpError("Engine /plans/7/drafts/9/apply failed: 409", 409, {
          code: "draft_changed",
          workspace: replacementWorkspace,
        }),
      )
      .mockResolvedValueOnce({
        profile_id: 7,
        draft_id: 9,
        revision_id: 4,
        plan_version: 2,
        draft_lifecycle_version: 1,
        revision_digest: "c".repeat(64),
        required_unit_mapping_digest: "d".repeat(64),
        applied_at: "2026-08-21T12:00:00.000Z",
      });

    await act(async () => {
      await expect(hook.result.current.applyActivePlanDraft()).rejects.toThrow(
        WORKING_PLAN_CHANGED_MESSAGE,
      );
    });

    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toEqual(
      replacementWorkspace,
    );

    await act(async () => {
      await hook.result.current.applyActivePlanDraft();
    });

    expect(applyPlanDraft).toHaveBeenCalledTimes(2);
    expect(applyPlanDraft).toHaveBeenNthCalledWith(
      1,
      savedWorkspace,
      undefined,
    );
    expect(applyPlanDraft).toHaveBeenNthCalledWith(
      2,
      replacementWorkspace,
      undefined,
    );
  });

  it("rebases changed Sources and finishes saving without a manual retry", async () => {
    const rebuiltWorkspace: PlanDraftWorkspace = {
      ...replacementWorkspace,
      draft: {
        ...replacementWorkspace.draft,
        draft_id: 10,
        snapshot_digest: "d".repeat(64),
      },
    };
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    vi.mocked(applyPlanDraft)
      .mockRejectedValueOnce(
        new EngineHttpError("Engine /plans/7/drafts/9/apply failed: 409", 409, {
          code: "inputs_changed",
        }),
      )
      .mockResolvedValueOnce({
        profile_id: 7,
        draft_id: 10,
        revision_id: 4,
        plan_version: 2,
        draft_lifecycle_version: 1,
        revision_digest: "e".repeat(64),
        required_unit_mapping_digest: "f".repeat(64),
        applied_at: "2026-08-21T12:00:00.000Z",
      });
    vi.mocked(rebasePlanDraft).mockResolvedValue(rebuiltWorkspace);

    await act(async () => {
      await hook.result.current.applyActivePlanDraft();
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(rebasePlanDraft).toHaveBeenCalledWith(7, savedWorkspace.draft);
    expect(abandonPlanDraft).not.toHaveBeenCalled();
    expect(hook.result.current.draftError).toBeNull();

    expect(applyPlanDraft).toHaveBeenCalledTimes(2);
    expect(applyPlanDraft).toHaveBeenNthCalledWith(
      1,
      savedWorkspace,
      undefined,
    );
    expect(applyPlanDraft).toHaveBeenNthCalledWith(
      2,
      rebuiltWorkspace,
      undefined,
    );
  });

  it("lets the server repair an unresolved Working Plan that has no choices", async () => {
    const legacyWorkspace: PlanDraftWorkspace = {
      ...savedWorkspace,
      reconciliation: { kind: "unresolved", conflicts: [] },
    };
    draftQueryState.workspace = legacyWorkspace;
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace).toEqual(legacyWorkspace),
    );

    await act(async () => {
      await hook.result.current.applyActivePlanDraft();
    });

    expect(applyPlanDraft).toHaveBeenCalledWith(legacyWorkspace, undefined);
  });

  it("keeps the saved draft open when production blocks Apply", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );
    client.setQueryData(queryKeys.planDraft(7, 9), savedWorkspace);
    vi.mocked(applyPlanDraft).mockRejectedValue(
      new EngineHttpError("Production is active", 423, {
        code: "production_active",
      }),
    );

    await act(async () => {
      await expect(hook.result.current.applyActivePlanDraft()).rejects.toThrow(
        "Production is active",
      );
    });

    expect(hook.result.current.draftWorkspace?.draft).toMatchObject({
      draft_id: 9,
      state: "open",
    });
    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toEqual(
      savedWorkspace,
    );
  });

  it("forwards remapCheckoffLinks when Apply is asked to preserve production links", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );

    await act(async () => {
      await hook.result.current.applyActivePlanDraft({
        remapCheckoffLinks: true,
      });
    });

    expect(applyPlanDraft).toHaveBeenCalledWith(savedWorkspace, {
      remapCheckoffLinks: true,
    });
    await waitFor(() => expect(hook.result.current.draftWorkspace).toBeNull());
  });

  it("rebases the exact open identity atomically and stores the successor", async () => {
    const staleWorkspace = {
      ...savedWorkspace,
      diff: { ...savedWorkspace.diff, base_is_current: false },
    };
    vi.mocked(usePlanDraftWorkspaceQuery).mockReturnValue({
      data: staleWorkspace,
      isLoading: false,
      error: null,
    } as ReturnType<typeof usePlanDraftWorkspaceQuery>);
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );

    await act(async () => {
      await hook.result.current.rebaseActivePlanDraft();
    });

    expect(abandonPlanDraft).not.toHaveBeenCalled();
    expect(rebasePlanDraft).toHaveBeenCalledWith(7, staleWorkspace.draft);
    expect(client.getQueryData(queryKeys.planDraft(7, 10))).toMatchObject({
      draft: { draft_id: 10, state: "open" },
    });
  });

  it("keeps conflicting pending edits open until the user explicitly discards them", async () => {
    const staleWorkspace: PlanDraftWorkspace = {
      ...savedWorkspace,
      diff: { ...savedWorkspace.diff, base_is_current: false },
    };
    draftQueryState.workspace = staleWorkspace;
    vi.mocked(rebasePlanDraft).mockRejectedValueOnce(new EngineHttpError("Overlapping changes", 409, { code: "merge_conflicts" }));
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).toEqual(staleWorkspace));
    await act(async () => { await expect(hook.result.current.preparePlan()).rejects.toThrow("Overlapping changes"); });
    expect(abandonPlanDraft).not.toHaveBeenCalled();
    expect(hook.result.current.mergeConflict).toBe(true);
    expect(hook.result.current.draftWorkspace?.draft.state).toBe("open");
    await act(async () => { await hook.result.current.discardPendingEdits(); });
    expect(abandonPlanDraft).toHaveBeenCalledWith(7, staleWorkspace.draft);
    expect(applyPlanDraft).not.toHaveBeenCalled();
    expect(hook.result.current.mergeConflict).toBe(false);
    expect(hook.result.current.draftError).toBeNull();
  });

  it("refreshes only the selected Build summary", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePlanWorkspace(), { wrapper: wrapper(client) });

    await act(() => result.current.refresh());

    expect(profileQueries.refreshProfileSummary).toHaveBeenCalledExactlyOnceWith(7);
    expect(profileQueries.invalidateProfiles).not.toHaveBeenCalled();
  });
});

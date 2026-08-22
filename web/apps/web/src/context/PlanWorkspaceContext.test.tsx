// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  EngineHttpError,
  rebasePlanDraft,
  type PlanDraftWorkspace,
  type PlanReview,
} from "../api/engine";
import { queryKeys } from "../queries/keys";
import { usePlanDraftWorkspaceQuery } from "../queries/planDraft";
import { PlanWorkspaceProvider, usePlanWorkspace } from "./PlanWorkspaceContext";

const acceptedReview: PlanReview = {
  profile_id: 7,
  accepted_basis: null,
  plan_name: "Accepted Plan",
  layers: [],
  totals: { included_parts: 0, total_print_units: 0, by_role: {}, by_filament: {} },
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
  parts: [],
  diff: { base_is_current: true, added: [], removed: [], changed: [] },
  reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
};

const replacementWorkspace: PlanDraftWorkspace = {
  ...savedWorkspace,
  draft: { ...savedWorkspace.draft, snapshot_digest: "b".repeat(64) },
};

vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    applyPlanDraft: vi.fn(),
    abandonPlanDraft: vi.fn(),
    editPlanDraftParts: vi.fn(),
    reconcilePlanDraft: vi.fn(),
    recomputePlanDraft: vi.fn(),
    rebasePlanDraft: vi.fn(),
  };
});

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true } }),
}));

vi.mock("./ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: 7 }),
}));

vi.mock("../queries/planReview", () => ({
  usePlanReviewQuery: () => ({ data: acceptedReview, isLoading: false, error: null }),
  usePatchPartMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartProgressMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartAssembledMutation: () => ({ mutateAsync: vi.fn() }),
  invalidatePlanReview: (client: QueryClient, profileId: number) =>
    client.invalidateQueries({ queryKey: queryKeys.planReview(profileId, false) }),
}));

vi.mock("../queries/profiles", () => ({
  invalidateProfiles: (client: QueryClient) =>
    client.invalidateQueries({ queryKey: queryKeys.profiles }),
}));

vi.mock("../queries/planDraft", () => ({
  usePlanDraftListQuery: () => ({
    data: [savedWorkspace.draft],
    isLoading: false,
    error: null,
  }),
  usePlanDraftWorkspaceQuery: vi.fn((_profileId: number | null, draftId: number | null) => ({
    data: draftId === savedWorkspace.draft.draft_id ? savedWorkspace : undefined,
    isLoading: false,
    error: null,
  })),
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
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

describe("PlanWorkspaceProvider saved draft lifecycle", () => {
  it("refetches the persisted open draft after each mount", async () => {
    const firstClient = new QueryClient();
    const first = renderHook(usePlanWorkspace, { wrapper: wrapper(firstClient) });
    await waitFor(() => expect(first.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    first.unmount();

    const secondClient = new QueryClient();
    const second = renderHook(usePlanWorkspace, { wrapper: wrapper(secondClient) });
    await waitFor(() => expect(second.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    expect(vi.mocked(usePlanDraftWorkspaceQuery)).toHaveBeenCalledWith(7, 9, true);
  });

  it("replaces the cached workspace on a stale edit and leaves accepted Review unchanged", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    vi.mocked(editPlanDraftParts).mockRejectedValue(new EngineHttpError(
      "Draft changed",
      409,
      { code: "draft_changed", workspace: replacementWorkspace },
    ));

    await act(async () => {
      await expect(hook.result.current.editActivePlanDraft([
        { kind: "set_included", draft_part_ids: [1], value: false },
      ])).rejects.toThrow("saved draft changed");
    });

    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toEqual(replacementWorkspace);
    expect(hook.result.current.review).toBe(acceptedReview);
    expect(hook.result.current.draftError).toMatch(/saved draft changed/i);
  });

  it("does not Apply implicitly and invalidates every accepted projection after explicit Apply", async () => {
    const client = new QueryClient();
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
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    expect(applyPlanDraft).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.applyActivePlanDraft();
    });

    expect(applyPlanDraft).toHaveBeenCalledWith(savedWorkspace, undefined);
    expect(client.getQueryState(queryKeys.planReview(7, false))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.profiles)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.checkoff(7))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.acceptedPlateWorkspace(7))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.acceptedPlateExportJobs(7))?.isInvalidated).toBe(true);
    await waitFor(() => expect(hook.result.current.draftWorkspace).toBeNull());
  });

  it("keeps the saved draft open when production blocks Apply", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));
    vi.mocked(applyPlanDraft).mockRejectedValue(new EngineHttpError(
      "Production is active",
      423,
      { code: "production_active" },
    ));

    await act(async () => {
      await expect(hook.result.current.applyActivePlanDraft()).rejects.toThrow("Production is active");
    });

    expect(hook.result.current.draftWorkspace?.draft).toMatchObject({ draft_id: 9, state: "open" });
    expect(client.getQueryData(queryKeys.planDraft(7, 9))).not.toBeNull();
  });

  it("forwards remapCheckoffLinks when Apply is asked to preserve production links", async () => {
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));

    await act(async () => {
      await hook.result.current.applyActivePlanDraft({ remapCheckoffLinks: true });
    });

    expect(applyPlanDraft).toHaveBeenCalledWith(savedWorkspace, { remapCheckoffLinks: true });
    await waitFor(() => expect(hook.result.current.draftWorkspace).toBeNull());
  });

  it("abandons the exact stale identity before rebasing and stores the successor", async () => {
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
    await waitFor(() => expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9));

    await act(async () => {
      await hook.result.current.rebaseActivePlanDraft();
    });

    expect(abandonPlanDraft).toHaveBeenCalledWith(7, staleWorkspace.draft);
    expect(rebasePlanDraft).toHaveBeenCalledWith(7, {
      ...staleWorkspace.draft,
      state: "abandoned",
      lifecycle_version: 1,
    });
    expect(client.getQueryData(queryKeys.planDraft(7, 10))).toMatchObject({
      draft: { draft_id: 10, state: "open" },
    });
  });
});

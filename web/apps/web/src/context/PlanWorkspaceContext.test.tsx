// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { EngineHttpError } from "../api/engineTransport";
import {
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  fetchPlanDraftWorkspace,
  listPlanDrafts,
  recomputePlanDraft,
  rebasePlanDraft,
} from "../api/endpoints/planDrafts";
import type { PlanReview } from "../api/endpoints/planManifests";
import { queryKeys } from "../queries/keys";
import { usePlanDraftWorkspaceQuery } from "../queries/planDraft";
import { WORKING_PLAN_CHANGED_MESSAGE } from "../lib/workingPlanChanged";
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
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true } }),
}));

vi.mock("./ProfileContext", () => ({
  useProfileSelection: () => ({
    selectedProfileId: profileSelectionState.selectedProfileId,
  }),
}));

vi.mock("../queries/planReview", () => ({
  usePlanReviewQuery: () => ({
    data: acceptedReview,
    isLoading: false,
    error: null,
  }),
  usePatchPartMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartProgressMutation: () => ({ mutateAsync: vi.fn() }),
  usePatchPartAssembledMutation: () => ({ mutateAsync: vi.fn() }),
  invalidatePlanReview: (client: QueryClient, profileId: number) =>
    client.invalidateQueries({
      queryKey: queryKeys.planReview(profileId, false),
    }),
}));

vi.mock("../queries/profiles", () => ({
  invalidateProfiles: (client: QueryClient) =>
    client.invalidateQueries({ queryKey: queryKeys.profiles }),
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

function workspaceWithQuantity(
  snapshotDigest: string,
  quantity: number,
): PlanDraftWorkspace {
  return {
    ...savedWorkspace,
    draft: {
      ...savedWorkspace.draft,
      snapshot_digest: snapshotDigest,
    },
    parts: savedWorkspace.parts.map((part) => ({
      ...part,
      quantity_override: quantity,
      quantity_effective: quantity,
    })),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  profileSelectionState.selectedProfileId = 7;
  draftQueryState.hasOpenDraft = true;
  draftQueryState.hasOtherWorkspace = false;
  draftQueryState.hasWorkspace = true;
  draftQueryState.listPending = false;
  draftQueryState.workspace = null;
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
    vi.mocked(applyPlanDraft).mockRejectedValueOnce(new EngineHttpError("Cannot move print", 422, {
      code: "checkoff_remap_unsafe", unmappable: [{ filename: "bracket.stl", reason: "removed" }],
    }));
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());
    await act(async () => { await expect(hook.result.current.setIncluded(planRow, false)).rejects.toThrow("bracket.stl"); });
    expect(client.getQueryData<PlanDraftWorkspace>(queryKeys.planDraft(7, 9))?.parts[0]?.included).toBe(false);
    expect(hook.result.current.draftError).toContain("Restore the affected file");
    expect(abandonPlanDraft).not.toHaveBeenCalled();
  });

  it("saves folder choices together in a single edit and apply", async () => {
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(hook.result.current.draftWorkspace).not.toBeNull());
    await act(async () => { await hook.result.current.setFilesIncluded([planRow], false); });
    expect(editPlanDraftParts).toHaveBeenCalledOnce();
    expect(applyPlanDraft).toHaveBeenCalledOnce();
  });

  it("starts a saved draft before editing inclusion from the Plan section", async () => {
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

    expect(recomputePlanDraft).toHaveBeenCalledWith(7);
    expect(editPlanDraftParts).toHaveBeenCalledWith({
      profileId: 7,
      draftId: 11,
      expectedSnapshotDigest: "c".repeat(64),
      decisions: [{ kind: "set_included", draft_part_ids: [17], value: false }],
    });
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
    expect(fetchPlanDraftWorkspace).toHaveBeenCalledWith(7, 9);
    expect(editPlanDraftParts).toHaveBeenCalledTimes(1);
    expect(editPlanDraftParts).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: 9,
        expectedSnapshotDigest: "a".repeat(64),
      }),
    );
  });

  it("waits for the draft list rather than rebuilding when a click lands mid-load", async () => {
    draftQueryState.hasWorkspace = false;
    draftQueryState.listPending = true;
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(listPlanDrafts).toHaveBeenCalledWith(7);
    expect(editPlanDraftParts).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild when the cached draft list is stale and empty", async () => {
    draftQueryState.hasWorkspace = false;
    const client = new QueryClient();
    client.setQueryData(queryKeys.planDrafts(7), []);
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(listPlanDrafts).toHaveBeenCalledWith(7);
    expect(editPlanDraftParts).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: 9,
        expectedSnapshotDigest: "a".repeat(64),
      }),
    );
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
    vi.mocked(editPlanDraftParts)
      .mockRejectedValueOnce(
        new EngineHttpError("Draft changed", 409, {
          code: "draft_changed",
          workspace: replacementWorkspace,
        }),
      )
      .mockResolvedValueOnce(editedWorkspace);

    await act(async () => {
      await hook.result.current.setIncluded(planRow, false);
    });

    expect(editPlanDraftParts).toHaveBeenCalledTimes(2);
    expect(editPlanDraftParts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedSnapshotDigest: "a".repeat(64),
      }),
    );
    expect(editPlanDraftParts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedSnapshotDigest: "b".repeat(64),
      }),
    );
    expect(applyPlanDraft).toHaveBeenCalledWith(editedWorkspace, { remapCheckoffLinks: true });
    expect(client.getQueryData(queryKeys.planDraft(7, 9))).toBeUndefined();
    expect(hook.result.current.draftError).toBeNull();
  });

  it("serializes rapid quantity edits against each saved snapshot", async () => {
    const first = deferred<PlanDraftWorkspace>();
    const second = deferred<PlanDraftWorkspace>();
    const third = deferred<PlanDraftWorkspace>();
    vi.mocked(editPlanDraftParts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const nextWorkspace = (digest: string, quantity: number, draftId: number): PlanDraftWorkspace => ({
      ...workspaceWithQuantity(digest, quantity),
      draft: { ...savedWorkspace.draft, draft_id: draftId, snapshot_digest: digest },
    });
    vi.mocked(recomputePlanDraft)
      .mockResolvedValueOnce(nextWorkspace("b".repeat(64), 2, 10))
      .mockResolvedValueOnce(nextWorkspace("c".repeat(64), 3, 11));
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

    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledTimes(1));
    expect(editPlanDraftParts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedSnapshotDigest: "a".repeat(64),
        decisions: [
          {
            kind: "set_quantity_override",
            draft_part_ids: [17],
            value: 2,
          },
        ],
      }),
    );

    await act(async () => {
      first.resolve(workspaceWithQuantity("b".repeat(64), 2));
      await first.promise;
    });
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledTimes(2));
    expect(editPlanDraftParts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedSnapshotDigest: "b".repeat(64),
        decisions: [
          {
            kind: "set_quantity_override",
            draft_part_ids: [17],
            value: 3,
          },
        ],
      }),
    );

    await act(async () => {
      second.resolve(nextWorkspace("c".repeat(64), 3, 10));
      await second.promise;
    });
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledTimes(3));
    expect(editPlanDraftParts).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        expectedSnapshotDigest: "c".repeat(64),
        decisions: [
          {
            kind: "set_quantity_override",
            draft_part_ids: [17],
            value: 4,
          },
        ],
      }),
    );

    await act(async () => {
      third.resolve(nextWorkspace("d".repeat(64), 4, 11));
      await Promise.all(edits);
    });
    expect(applyPlanDraft).toHaveBeenCalledTimes(3);
    expect(applyPlanDraft).toHaveBeenLastCalledWith(nextWorkspace("d".repeat(64), 4, 11), { remapCheckoffLinks: true });
    expect(client.getQueryData(queryKeys.planDraft(7, 11))).toBeUndefined();
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
    const buildAEdit = deferred<PlanDraftWorkspace>();
    vi.mocked(editPlanDraftParts).mockReturnValueOnce(buildAEdit.promise);
    const client = new QueryClient();
    const hook = renderHook(usePlanWorkspace, { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(hook.result.current.draftWorkspace?.draft.draft_id).toBe(9),
    );

    let buildAEditPromise: Promise<void> | null = null;
    act(() => {
      buildAEditPromise = hook.result.current.setIncluded(planRow, false);
    });
    await waitFor(() => expect(editPlanDraftParts).toHaveBeenCalledOnce());
    expect(hook.result.current.busyPartId).toBe(planRow.id);

    profileSelectionState.selectedProfileId = 8;
    hook.rerender();
    expect(hook.result.current.busyPartId).toBeNull();
    expect(hook.result.current.draftError).toBeNull();

    const pendingBuildAEdit = buildAEditPromise;
    if (!pendingBuildAEdit)
      throw new Error("Expected the Build A edit to be pending");
    await act(async () => {
      buildAEdit.reject(new Error("Build A disk full"));
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
    expect(
      client.getQueryState(queryKeys.planReview(7, false))?.isInvalidated,
    ).toBe(true);
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

  it("rebases changed Sources without discarding the open Plan's edits", async () => {
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
      await expect(hook.result.current.applyActivePlanDraft()).rejects.toThrow(
        "Another change reached this Working Plan",
      );
    });

    expect(recomputePlanDraft).not.toHaveBeenCalled();
    expect(rebasePlanDraft).toHaveBeenCalledWith(7, savedWorkspace.draft);
    expect(abandonPlanDraft).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.planDraft(7, 10))).toEqual(
      rebuiltWorkspace,
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
});

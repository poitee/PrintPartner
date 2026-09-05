import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  parsePlanDraftWorkspace,
  type ApplyPlanDraftReceipt,
  type PlanDraftPartDecisionContract,
  type PlanDraftWorkspace,
  type RequiredUnitDecisionContract,
} from "@print-partner/contracts";
import { EngineHttpError } from "../api/engineTransport";
import {
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  fetchPlanDraftWorkspace,
  listPlanDrafts,
  reconcilePlanDraft,
  rebasePlanDraft,
  recomputePlanDraft,
} from "../api/endpoints/planDrafts";
import type { PlanReview } from "../api/endpoints/planManifests";
import { formatCheckoffSummary } from "../lib/checkoffProgress";
import { useEngineHealth } from "../hooks/useEngineHealth";
import {
  invalidatePlanReview,
  usePatchPartAssembledMutation,
  usePatchPartMutation,
  usePatchPartProgressMutation,
  usePlanReviewQuery,
} from "../queries/planReview";
import { invalidateProfiles } from "../queries/profiles";
import { queryKeys } from "../queries/keys";
import {
  usePlanDraftListQuery,
  usePlanDraftWorkspaceQuery,
} from "../queries/planDraft";
import {
  draftPartMatchError,
  resolveDraftPart,
  type PlanRowIdentity,
} from "../lib/planDraftPartMatch";
import { latestOpenDraftId } from "../lib/planDraftUi";
import {
  isWorkingPlanInputsChanged,
  WorkingPlanChangedError,
} from "../lib/workingPlanChanged";
import { useProfileSelection } from "./ProfileContext";

/** The Plan row being edited — enough identity to find it in the saved draft. */
export type PlanEditablePart = PlanRowIdentity & {
  readonly id: number;
  readonly filename: string;
};

export type QuantityUpdate =
  | number
  | ((currentQuantity: number) => number);

type DraftPartEdit =
  | { kind: "set_included"; value: boolean }
  | { kind: "set_quantity"; value: QuantityUpdate };

type BuildDraftUiState = Readonly<{
  activeDraftId: number | null;
  recentlyAppliedDraftId: number | null;
  draftMutationError: string | null;
  busyPartId: number | null;
}>;

const EMPTY_BUILD_DRAFT_UI_STATE: BuildDraftUiState = {
  activeDraftId: null,
  recentlyAppliedDraftId: null,
  draftMutationError: null,
  busyPartId: null,
};

type PlanWorkspaceValue = {
  review: PlanReview | null;
  loading: boolean;
  error: string | null;
  progressSummary: string;
  refresh: () => Promise<void>;
  draftWorkspace: PlanDraftWorkspace | null;
  draftLoading: boolean;
  draftError: string | null;
  startPlanDraft: () => Promise<PlanDraftWorkspace>;
  applyActivePlanDraft: (options?: {
    remapCheckoffLinks?: boolean;
  }) => Promise<ApplyPlanDraftReceipt>;
  rebaseActivePlanDraft: () => Promise<PlanDraftWorkspace>;
  reconcileActivePlanDraft: (
    decisions: RequiredUnitDecisionContract[],
  ) => Promise<PlanDraftWorkspace>;
  editActivePlanDraft: (
    decisions: PlanDraftPartDecisionContract[],
  ) => Promise<PlanDraftWorkspace>;
  setQuantity: (
    part: PlanEditablePart,
    update: QuantityUpdate,
  ) => Promise<void>;
  setIncluded: (part: PlanEditablePart, included: boolean) => Promise<void>;
  setSpoolmanSpool: (
    partId: number,
    spoolman_spool_id: string | null,
  ) => Promise<void>;
  toggleUnit: (
    partId: number,
    unitIndex: number,
    completed: boolean,
  ) => Promise<void>;
  toggleAssembled: (
    partId: number,
    unitIndex: number,
    assembled: boolean,
  ) => Promise<void>;
  busyPartId: number | null;
};

const PlanWorkspaceContext = createContext<PlanWorkspaceValue | null>(null);

function summaryFromReview(review: PlanReview | null): string {
  if (!review) return "";
  const parts = review.part_groups
    .flatMap((g) => g.parts)
    .filter((p) => p.included);
  return formatCheckoffSummary(
    parts.map((p) => ({
      quantity_effective: p.quantity_effective,
      printed_count: p.printed_count,
      missing: p.missing,
    })),
  );
}

export function PlanWorkspaceProvider({ children }: { children: ReactNode }) {
  const { health } = useEngineHealth();
  const { selectedProfileId } = useProfileSelection();
  const queryClient = useQueryClient();
  const [draftUiByBuild, setDraftUiByBuild] = useState<
    ReadonlyMap<number, BuildDraftUiState>
  >(() => new Map());
  const draftUiByBuildRef = useRef(draftUiByBuild);
  const draftEditQueueByBuild = useRef<Map<number, Promise<void>>>(new Map());
  const selectedDraftUi =
    selectedProfileId == null
      ? EMPTY_BUILD_DRAFT_UI_STATE
      : (draftUiByBuild.get(selectedProfileId) ?? EMPTY_BUILD_DRAFT_UI_STATE);
  const {
    activeDraftId,
    recentlyAppliedDraftId,
    draftMutationError,
    busyPartId,
  } = selectedDraftUi;

  const updateDraftUi = useCallback(
    (
      profileId: number,
      update: (current: BuildDraftUiState) => BuildDraftUiState,
    ) => {
      const currentByBuild = draftUiByBuildRef.current;
      const current =
        currentByBuild.get(profileId) ?? EMPTY_BUILD_DRAFT_UI_STATE;
      const next = update(current);
      if (next === current) return;
      const nextByBuild = new Map(currentByBuild);
      nextByBuild.set(profileId, next);
      draftUiByBuildRef.current = nextByBuild;
      setDraftUiByBuild(nextByBuild);
    },
    [],
  );

  const {
    data: review = null,
    isLoading,
    error: queryError,
  } = usePlanReviewQuery(selectedProfileId, {
    includeExcluded: false,
    enabled: Boolean(health?.ok),
  });

  const patchPartMutation = usePatchPartMutation(selectedProfileId);
  const patchProgressMutation = usePatchPartProgressMutation(
    selectedProfileId,
    false,
  );
  const patchAssembledMutation = usePatchPartAssembledMutation(
    selectedProfileId,
    false,
  );
  const draftListQuery = usePlanDraftListQuery(
    selectedProfileId,
    Boolean(health?.ok),
  );
  const draftQuery = usePlanDraftWorkspaceQuery(
    selectedProfileId,
    activeDraftId,
    Boolean(health?.ok),
  );

  useEffect(() => {
    if (selectedProfileId == null || activeDraftId != null) return;
    const open = latestOpenDraftId(draftListQuery.data, recentlyAppliedDraftId);
    if (open != null) {
      updateDraftUi(selectedProfileId, (current) => ({
        ...current,
        activeDraftId: open,
      }));
    }
    if (
      recentlyAppliedDraftId != null &&
      !(draftListQuery.data ?? []).some(
        (draft) =>
          draft.draft_id === recentlyAppliedDraftId && draft.state === "open",
      )
    ) {
      updateDraftUi(selectedProfileId, (current) => ({
        ...current,
        recentlyAppliedDraftId: null,
      }));
    }
  }, [
    activeDraftId,
    draftListQuery.data,
    recentlyAppliedDraftId,
    selectedProfileId,
    updateDraftUi,
  ]);

  const refresh = useCallback(async () => {
    if (!health?.ok || selectedProfileId == null) return;
    await Promise.all([
      invalidatePlanReview(queryClient, selectedProfileId),
      invalidateProfiles(queryClient),
    ]);
  }, [health?.ok, queryClient, selectedProfileId]);

  const storeWorkspace = useCallback(
    (workspace: PlanDraftWorkspace) => {
      updateDraftUi(workspace.profile_id, (current) => ({
        ...current,
        activeDraftId: workspace.draft.draft_id,
      }));
      queryClient.setQueryData(
        queryKeys.planDraft(workspace.profile_id, workspace.draft.draft_id),
        workspace,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.planDrafts(workspace.profile_id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.buildWorkflow(workspace.profile_id),
      });
      return workspace;
    },
    [queryClient, updateDraftUi],
  );

  const replaceFromConflict = useCallback(
    (profileId: number, error: unknown): boolean => {
      if (!(error instanceof EngineHttpError) || error.status !== 409)
        return false;
      if (
        !error.body ||
        typeof error.body !== "object" ||
        !("workspace" in error.body)
      )
        return false;
      try {
        const workspace = parsePlanDraftWorkspace(error.body.workspace);
        if (workspace.profile_id !== profileId) return false;
        storeWorkspace(workspace);
        return true;
      } catch {
        return false;
      }
    },
    [storeWorkspace],
  );

  const currentDraftWorkspace = useCallback(
    (profileId: number) => {
      const profileDraftId =
        draftUiByBuildRef.current.get(profileId)?.activeDraftId ?? null;
      const selectedWorkspace =
        selectedProfileId === profileId &&
        draftQuery.data?.profile_id === profileId
          ? draftQuery.data
          : undefined;
      return profileDraftId != null
        ? (queryClient.getQueryData<PlanDraftWorkspace>(
            queryKeys.planDraft(profileId, profileDraftId),
          ) ?? selectedWorkspace)
        : selectedWorkspace;
    },
    [draftQuery.data, queryClient, selectedProfileId],
  );

  const enqueueDraftEdit = useCallback(
    <T,>(profileId: number, operation: () => Promise<T>): Promise<T> => {
      const currentQueue =
        draftEditQueueByBuild.current.get(profileId) ?? Promise.resolve();
      const result = currentQueue.then(operation);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      draftEditQueueByBuild.current.set(profileId, settled);
      void settled.then(() => {
        if (draftEditQueueByBuild.current.get(profileId) === settled) {
          draftEditQueueByBuild.current.delete(profileId);
        }
      });
      return result;
    },
    [],
  );

  const startPlanDraftForProfile = useCallback(
    async (profileId: number) => {
      updateDraftUi(profileId, (current) => ({
        ...current,
        draftMutationError: null,
      }));
      try {
        return storeWorkspace(await recomputePlanDraft(profileId));
      } catch (error) {
        updateDraftUi(profileId, (current) => ({
          ...current,
          draftMutationError:
            error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
    },
    [storeWorkspace, updateDraftUi],
  );

  const startPlanDraft = useCallback(async () => {
    if (selectedProfileId == null)
      throw new Error("Select a Build before creating its Working Plan");
    return startPlanDraftForProfile(selectedProfileId);
  }, [selectedProfileId, startPlanDraftForProfile]);

  const persistDraftEdit = useCallback(
    async (
      workspace: PlanDraftWorkspace,
      decisions: PlanDraftPartDecisionContract[],
    ) =>
      storeWorkspace(
        await editPlanDraftParts({
          profileId: workspace.profile_id,
          draftId: workspace.draft.draft_id,
          expectedSnapshotDigest: workspace.draft.snapshot_digest,
          decisions,
        }),
      ),
    [storeWorkspace],
  );

  const editWorkspaceParts = useCallback(
    async (
      workspace: PlanDraftWorkspace,
      decisions: PlanDraftPartDecisionContract[],
    ) => {
      updateDraftUi(workspace.profile_id, (current) => ({
        ...current,
        draftMutationError: null,
      }));
      try {
        return await persistDraftEdit(workspace, decisions);
      } catch (error) {
        const replaced = replaceFromConflict(workspace.profile_id, error);
        const message = replaced
          ? "The Working Plan changed. Review it and retry this edit."
          : error instanceof Error
            ? error.message
            : String(error);
        updateDraftUi(workspace.profile_id, (current) => ({
          ...current,
          draftMutationError: message,
        }));
        throw new Error(message, { cause: error });
      }
    },
    [persistDraftEdit, replaceFromConflict, updateDraftUi],
  );

  /**
   * The open Working Plan, fetched when the cache is cold.
   *
   * A click must never rebuild the Plan. Recompute abandons the open draft and
   * builds a fresh one from Sources, which silently drops every inclusion and
   * quantity edit that has not been published yet — so a tap that lands before
   * GET /plans/:id/drafts resolves has to wait for that draft, not replace it.
   * Returns null only when the server genuinely holds no open draft.
   */
  const resolveOpenDraftWorkspace =
    useCallback(async (profileId: number): Promise<PlanDraftWorkspace | null> => {
      const cached = currentDraftWorkspace(profileId);
      if (cached) return cached;
      const drafts = await queryClient.fetchQuery({
        queryKey: queryKeys.planDrafts(profileId),
        queryFn: () => listPlanDrafts(profileId),
        staleTime: 0,
      });
      const recentlyApplied =
        draftUiByBuildRef.current.get(profileId)?.recentlyAppliedDraftId ??
        null;
      const openDraftId = latestOpenDraftId(drafts, recentlyApplied);
      if (openDraftId == null) return null;
      try {
        const workspace = await queryClient.ensureQueryData({
          queryKey: queryKeys.planDraft(profileId, openDraftId),
          queryFn: () => fetchPlanDraftWorkspace(profileId, openDraftId),
        });
        return storeWorkspace(workspace);
      } catch (error) {
        // A draft deleted underneath us leaves nothing to preserve.
        if (error instanceof EngineHttpError && error.status === 404)
          return null;
        throw error;
      }
    }, [
      currentDraftWorkspace,
      queryClient,
      storeWorkspace,
    ]);

  const editActivePlanDraft = useCallback(
    (decisions: PlanDraftPartDecisionContract[]) => {
      const profileId = selectedProfileId;
      if (profileId == null)
        return Promise.reject(
          new Error("Select a Build before editing its Working Plan"),
        );
      return enqueueDraftEdit(profileId, async () => {
        const workspace = await resolveOpenDraftWorkspace(profileId);
        if (!workspace)
          throw new Error("Create a Working Plan from Sources first");
        return editWorkspaceParts(workspace, decisions);
      });
    },
    [
      editWorkspaceParts,
      enqueueDraftEdit,
      resolveOpenDraftWorkspace,
      selectedProfileId,
    ],
  );

  const editDraft = useCallback(
    (part: PlanEditablePart, edit: DraftPartEdit) => {
      const profileId = selectedProfileId;
      if (profileId == null)
        return Promise.reject(
          new Error("Select a Build before editing its Working Plan"),
        );
      return enqueueDraftEdit(profileId, async () => {
        updateDraftUi(profileId, (current) => ({
          ...current,
          busyPartId: part.id,
          draftMutationError: null,
        }));
        const fail: (message: string) => never = (message) => {
          updateDraftUi(profileId, (current) => ({
            ...current,
            draftMutationError: message,
          }));
          throw new Error(message);
        };
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const open = await resolveOpenDraftWorkspace(profileId);
            const workspace =
              open ??
              (attempt === 0
                ? await startPlanDraftForProfile(profileId)
                : null);
            if (!workspace) fail("Create a Working Plan from Sources first");
            const match = resolveDraftPart(workspace.parts, part);
            if (match.kind !== "resolved")
              fail(draftPartMatchError(match, part.filename));
            const draftPartId = match.part.draft_part_id;
            const decision: PlanDraftPartDecisionContract =
              edit.kind === "set_included"
                ? {
                    kind: "set_included",
                    draft_part_ids: [draftPartId],
                    value: edit.value,
                  }
                : {
                    kind: "set_quantity_override",
                    draft_part_ids: [draftPartId],
                    value: Math.max(
                      1,
                      Math.floor(
                        typeof edit.value === "function"
                          ? edit.value(match.part.quantity_effective)
                          : edit.value,
                      ),
                    ),
                  };
            try {
              await persistDraftEdit(workspace, [decision]);
              return;
            } catch (error) {
              const replaced = replaceFromConflict(profileId, error);
              if (replaced && attempt === 0) continue;
              const message = replaced
                ? "The Working Plan changed. Review it and retry this edit."
                : error instanceof Error
                  ? error.message
                  : String(error);
              updateDraftUi(profileId, (current) => ({
                ...current,
                draftMutationError: message,
              }));
              throw new Error(message, { cause: error });
            }
          }
        } finally {
          updateDraftUi(profileId, (current) => ({
            ...current,
            busyPartId: null,
          }));
        }
      });
    },
    [
      enqueueDraftEdit,
      persistDraftEdit,
      replaceFromConflict,
      resolveOpenDraftWorkspace,
      selectedProfileId,
      startPlanDraftForProfile,
      updateDraftUi,
    ],
  );

  const setQuantity = useCallback(
    async (part: PlanEditablePart, update: QuantityUpdate) => {
      if (!review) return;
      await editDraft(part, { kind: "set_quantity", value: update });
    },
    [review, editDraft],
  );

  const setIncluded = useCallback(
    async (part: PlanEditablePart, included: boolean) => {
      if (!review) return;
      await editDraft(part, { kind: "set_included", value: included });
    },
    [review, editDraft],
  );

  const reconcileActivePlanDraft = useCallback(
    async (decisions: RequiredUnitDecisionContract[]) => {
      if (selectedProfileId == null)
        throw new Error("No Working Plan is open");
      const workspace = currentDraftWorkspace(selectedProfileId);
      if (!workspace) throw new Error("No Working Plan is open");
      const next = await reconcilePlanDraft({
        profileId: workspace.profile_id,
        draftId: workspace.draft.draft_id,
        expectedSnapshotDigest: workspace.draft.snapshot_digest,
        decisions,
      });
      return storeWorkspace(next);
    },
    [currentDraftWorkspace, selectedProfileId, storeWorkspace],
  );

  const applyActivePlanDraft = useCallback(
    async (options?: { remapCheckoffLinks?: boolean }) => {
      if (selectedProfileId == null)
        throw new Error("No Working Plan is open");
      const workspace = currentDraftWorkspace(selectedProfileId);
      if (!workspace) throw new Error("No Working Plan is open");
      if (!workspace.diff.base_is_current)
        throw new Error("Refresh this Working Plan before acceptance");
      if (
        workspace.reconciliation.kind === "unresolved" &&
        workspace.reconciliation.conflicts.length > 0
      ) {
        throw new Error("Resolve Required-unit changes before acceptance");
      }
      let receipt: ApplyPlanDraftReceipt;
      try {
        receipt = await applyPlanDraft(workspace, options);
      } catch (error) {
        if (isWorkingPlanInputsChanged(error)) {
          await startPlanDraftForProfile(workspace.profile_id);
          throw new WorkingPlanChangedError("rebuilt_from_sources", {
            cause: error,
          });
        }
        if (replaceFromConflict(workspace.profile_id, error)) {
          throw new WorkingPlanChangedError("refreshed", { cause: error });
        }
        throw error;
      }
      updateDraftUi(workspace.profile_id, (current) => ({
        ...current,
        recentlyAppliedDraftId: workspace.draft.draft_id,
        activeDraftId: null,
      }));
      queryClient.removeQueries({
        queryKey: queryKeys.planDraft(
          workspace.profile_id,
          workspace.draft.draft_id,
        ),
        exact: true,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.planDrafts(workspace.profile_id),
        }),
        invalidatePlanReview(queryClient, workspace.profile_id),
        invalidateProfiles(queryClient),
        queryClient.invalidateQueries({
          queryKey: queryKeys.checkoff(workspace.profile_id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.acceptedPlateWorkspace(workspace.profile_id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.acceptedPlateExportJobs(workspace.profile_id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.buildWorkflow(workspace.profile_id),
        }),
      ]);
      return receipt;
    },
    [
      currentDraftWorkspace,
      queryClient,
      replaceFromConflict,
      selectedProfileId,
      startPlanDraftForProfile,
      updateDraftUi,
    ],
  );

  const rebaseActivePlanDraft = useCallback(async () => {
    if (selectedProfileId == null)
      throw new Error("No Working Plan is open");
    const workspace = currentDraftWorkspace(selectedProfileId);
    if (!workspace) throw new Error("No Working Plan is open");
    if (workspace.diff.base_is_current)
      throw new Error("This Working Plan already uses the Accepted Plan");
    updateDraftUi(workspace.profile_id, (current) => ({
      ...current,
      draftMutationError: null,
    }));
    try {
      const abandoned =
        workspace.draft.state === "abandoned"
          ? workspace.draft
          : await abandonPlanDraft(workspace.profile_id, workspace.draft);
      if (workspace.draft !== abandoned) {
        storeWorkspace({ ...workspace, draft: abandoned });
      }
      return storeWorkspace(
        await rebasePlanDraft(workspace.profile_id, abandoned),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateDraftUi(workspace.profile_id, (current) => ({
        ...current,
        draftMutationError: message,
      }));
      throw error;
    }
  }, [currentDraftWorkspace, selectedProfileId, storeWorkspace, updateDraftUi]);

  const setSpoolmanSpool = useCallback(
    async (partId: number, spoolman_spool_id: string | null) => {
      if (!review || selectedProfileId == null) return;
      const profileId = selectedProfileId;
      updateDraftUi(profileId, (current) => ({
        ...current,
        busyPartId: partId,
      }));
      try {
        await patchPartMutation.mutateAsync({
          partId,
          body: { spoolman_spool_id },
        });
      } finally {
        updateDraftUi(profileId, (current) => ({
          ...current,
          busyPartId: null,
        }));
      }
    },
    [review, patchPartMutation, selectedProfileId, updateDraftUi],
  );

  const toggleUnit = useCallback(
    async (partId: number, unitIndex: number, completed: boolean) => {
      if (!review || selectedProfileId == null) return;
      const profileId = selectedProfileId;
      updateDraftUi(profileId, (current) => ({
        ...current,
        busyPartId: partId,
      }));
      try {
        await patchProgressMutation.mutateAsync({
          partId,
          unitIndex,
          completed,
          optimisticReview: review,
        });
      } finally {
        updateDraftUi(profileId, (current) => ({
          ...current,
          busyPartId: null,
        }));
      }
    },
    [review, patchProgressMutation, selectedProfileId, updateDraftUi],
  );

  const toggleAssembled = useCallback(
    async (partId: number, unitIndex: number, assembled: boolean) => {
      if (!review || selectedProfileId == null) return;
      const profileId = selectedProfileId;
      updateDraftUi(profileId, (current) => ({
        ...current,
        busyPartId: partId,
      }));
      try {
        await patchAssembledMutation.mutateAsync({
          partId,
          unitIndex,
          assembled,
          optimisticReview: review,
        });
      } finally {
        updateDraftUi(profileId, (current) => ({
          ...current,
          busyPartId: null,
        }));
      }
    },
    [review, patchAssembledMutation, selectedProfileId, updateDraftUi],
  );

  const value = useMemo(
    (): PlanWorkspaceValue => ({
      review,
      draftWorkspace: draftQuery.data ?? null,
      draftLoading: draftListQuery.isLoading || draftQuery.isLoading,
      draftError:
        draftMutationError ??
        (draftQuery.error instanceof Error ? draftQuery.error.message : null) ??
        (draftListQuery.error instanceof Error
          ? draftListQuery.error.message
          : null),
      startPlanDraft,
      applyActivePlanDraft,
      rebaseActivePlanDraft,
      reconcileActivePlanDraft,
      editActivePlanDraft,
      loading: isLoading,
      error:
        queryError instanceof Error
          ? queryError.message
          : queryError
            ? String(queryError)
            : null,
      progressSummary: summaryFromReview(review),
      refresh,
      setQuantity,
      setIncluded,
      setSpoolmanSpool,
      toggleUnit,
      toggleAssembled,
      busyPartId,
    }),
    [
      review,
      draftQuery.data,
      draftQuery.error,
      draftQuery.isLoading,
      draftListQuery.error,
      draftListQuery.isLoading,
      draftMutationError,
      startPlanDraft,
      applyActivePlanDraft,
      rebaseActivePlanDraft,
      reconcileActivePlanDraft,
      editActivePlanDraft,
      isLoading,
      queryError,
      refresh,
      setQuantity,
      setIncluded,
      setSpoolmanSpool,
      toggleUnit,
      toggleAssembled,
      busyPartId,
    ],
  );

  return (
    <PlanWorkspaceContext.Provider value={value}>
      {children}
    </PlanWorkspaceContext.Provider>
  );
}

export function usePlanWorkspace(): PlanWorkspaceValue {
  const ctx = useContext(PlanWorkspaceContext);
  if (!ctx) throw new Error("usePlanWorkspace requires PlanWorkspaceProvider");
  return ctx;
}

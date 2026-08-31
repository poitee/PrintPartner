import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { usePlanDraftListQuery, usePlanDraftWorkspaceQuery } from "../queries/planDraft";
import {
  draftPartMatchError,
  resolveDraftPart,
  type PlanRowIdentity,
} from "../lib/planDraftPartMatch";
import { useProfileSelection } from "./ProfileContext";

/** The Plan row being edited — enough identity to find it in the saved draft. */
export type PlanEditablePart = PlanRowIdentity & {
  readonly id: number;
  readonly filename: string;
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
  applyActivePlanDraft: (options?: { remapCheckoffLinks?: boolean }) => Promise<ApplyPlanDraftReceipt>;
  rebaseActivePlanDraft: () => Promise<PlanDraftWorkspace>;
  reconcileActivePlanDraft: (decisions: RequiredUnitDecisionContract[]) => Promise<PlanDraftWorkspace>;
  editActivePlanDraft: (decisions: PlanDraftPartDecisionContract[]) => Promise<PlanDraftWorkspace>;
  setQuantity: (part: PlanEditablePart, qty: number) => Promise<void>;
  setIncluded: (part: PlanEditablePart, included: boolean) => Promise<void>;
  setSpoolmanSpool: (partId: number, spoolman_spool_id: string | null) => Promise<void>;
  toggleUnit: (partId: number, unitIndex: number, completed: boolean) => Promise<void>;
  toggleAssembled: (partId: number, unitIndex: number, assembled: boolean) => Promise<void>;
  busyPartId: number | null;
};

const PlanWorkspaceContext = createContext<PlanWorkspaceValue | null>(null);

function summaryFromReview(review: PlanReview | null): string {
  if (!review) return "";
  const parts = review.part_groups.flatMap((g) => g.parts).filter((p) => p.included);
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
  const [busyPartId, setBusyPartId] = useState<number | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<number | null>(null);
  const [recentlyAppliedDraftId, setRecentlyAppliedDraftId] = useState<number | null>(null);
  const [draftMutationError, setDraftMutationError] = useState<string | null>(null);

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
  const draftListQuery = usePlanDraftListQuery(selectedProfileId, Boolean(health?.ok));
  const draftQuery = usePlanDraftWorkspaceQuery(
    selectedProfileId,
    activeDraftId,
    Boolean(health?.ok),
  );

  useEffect(() => {
    setActiveDraftId(null);
    setRecentlyAppliedDraftId(null);
    setDraftMutationError(null);
  }, [selectedProfileId]);

  useEffect(() => {
    if (activeDraftId != null) return;
    const open = [...(draftListQuery.data ?? [])]
      .reverse()
      .find((draft) => draft.state === "open" && draft.draft_id !== recentlyAppliedDraftId);
    if (open) setActiveDraftId(open.draft_id);
    if (
      recentlyAppliedDraftId != null &&
      !(draftListQuery.data ?? []).some((draft) => (
        draft.draft_id === recentlyAppliedDraftId && draft.state === "open"
      ))
    ) {
      setRecentlyAppliedDraftId(null);
    }
  }, [activeDraftId, draftListQuery.data, recentlyAppliedDraftId]);

  const refresh = useCallback(async () => {
    if (!health?.ok || selectedProfileId == null) return;
    await Promise.all([
      invalidatePlanReview(queryClient, selectedProfileId),
      invalidateProfiles(queryClient),
    ]);
  }, [health?.ok, queryClient, selectedProfileId]);

  const storeWorkspace = useCallback((workspace: PlanDraftWorkspace) => {
    setActiveDraftId(workspace.draft.draft_id);
    queryClient.setQueryData(
      queryKeys.planDraft(workspace.profile_id, workspace.draft.draft_id),
      workspace,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.planDrafts(workspace.profile_id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.buildWorkflow(workspace.profile_id) });
    return workspace;
  }, [queryClient]);

  const replaceFromConflict = useCallback((error: unknown): boolean => {
    if (!(error instanceof EngineHttpError) || error.status !== 409) return false;
    if (!error.body || typeof error.body !== "object" || !("workspace" in error.body)) return false;
    try {
      storeWorkspace(parsePlanDraftWorkspace(error.body.workspace));
      return true;
    } catch {
      return false;
    }
  }, [storeWorkspace]);

  const currentDraftWorkspace = useCallback(() => (
    selectedProfileId != null && activeDraftId != null
      ? queryClient.getQueryData<PlanDraftWorkspace>(
          queryKeys.planDraft(selectedProfileId, activeDraftId),
        ) ?? draftQuery.data
      : draftQuery.data
  ), [activeDraftId, draftQuery.data, queryClient, selectedProfileId]);

  const startPlanDraft = useCallback(async () => {
    if (selectedProfileId == null) throw new Error("Select a Build before creating its Working Plan");
    setDraftMutationError(null);
    try {
      return storeWorkspace(await recomputePlanDraft(selectedProfileId));
    } catch (error) {
      setDraftMutationError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [selectedProfileId, storeWorkspace]);

  const persistDraftEdit = useCallback(async (
    workspace: PlanDraftWorkspace,
    decisions: PlanDraftPartDecisionContract[],
  ) => storeWorkspace(await editPlanDraftParts({
    profileId: workspace.profile_id,
    draftId: workspace.draft.draft_id,
    expectedSnapshotDigest: workspace.draft.snapshot_digest,
    decisions,
  })), [storeWorkspace]);

  const editWorkspaceParts = useCallback(async (
    workspace: PlanDraftWorkspace,
    decisions: PlanDraftPartDecisionContract[],
  ) => {
    try {
      return await persistDraftEdit(workspace, decisions);
    } catch (error) {
      const replaced = replaceFromConflict(error);
      const message = replaced
        ? "The Working Plan changed. Review it and retry this edit."
        : error instanceof Error ? error.message : String(error);
      setDraftMutationError(message);
      throw new Error(message, { cause: error });
    }
  }, [persistDraftEdit, replaceFromConflict]);

  const editActivePlanDraft = useCallback(async (decisions: PlanDraftPartDecisionContract[]) => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("Create a Working Plan from Sources first");
    return editWorkspaceParts(workspace, decisions);
  }, [currentDraftWorkspace, editWorkspaceParts]);

  const editDraft = useCallback(async (
    part: PlanEditablePart,
    decision: "included" | "quantity",
    value: boolean | number,
  ) => {
    setBusyPartId(part.id);
    setDraftMutationError(null);
    // Every exit reports through draftMutationError: a Plan click that fails
    // silently reads to the user as a dead button.
    // Explicit annotation so TypeScript narrows on the `never` return.
    const fail: (message: string) => never = (message) => {
      setDraftMutationError(message);
      throw new Error(message);
    };
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // The Plan section is also an editing surface. Create a Working Plan on the
        // first attempt when the user has not opened one yet.
        const workspace = currentDraftWorkspace() ?? (attempt === 0 ? await startPlanDraft() : null);
        if (!workspace) fail("Create a Working Plan from Sources first");
        const match = resolveDraftPart(workspace.parts, part);
        if (match.kind !== "resolved") fail(draftPartMatchError(match, part.filename));
        const draftPartId = match.part.draft_part_id;
        try {
          await persistDraftEdit(workspace, [
            decision === "included"
              ? { kind: "set_included", draft_part_ids: [draftPartId], value: Boolean(value) }
              : { kind: "set_quantity_override", draft_part_ids: [draftPartId], value: Number(value) },
          ]);
          return;
        } catch (error) {
          const replaced = replaceFromConflict(error);
          if (replaced && attempt === 0) continue;
          const message = replaced
            ? "The Working Plan changed. Review it and retry this edit."
            : error instanceof Error ? error.message : String(error);
          setDraftMutationError(message);
          throw new Error(message, { cause: error });
        }
      }
    } finally {
      setBusyPartId(null);
    }
  }, [currentDraftWorkspace, persistDraftEdit, replaceFromConflict, startPlanDraft]);

  const setQuantity = useCallback(
    async (part: PlanEditablePart, qty: number) => {
      if (!review) return;
      const clamped = Math.max(1, Math.floor(qty));
      await editDraft(part, "quantity", clamped);
    },
    [review, editDraft],
  );

  const setIncluded = useCallback(
    async (part: PlanEditablePart, included: boolean) => {
      if (!review) return;
      await editDraft(part, "included", included);
    },
    [review, editDraft],
  );

  const reconcileActivePlanDraft = useCallback(async (decisions: RequiredUnitDecisionContract[]) => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("No Working Plan is open");
    const next = await reconcilePlanDraft({
      profileId: workspace.profile_id,
      draftId: workspace.draft.draft_id,
      expectedSnapshotDigest: workspace.draft.snapshot_digest,
      decisions,
    });
    return storeWorkspace(next);
  }, [currentDraftWorkspace, storeWorkspace]);

  const applyActivePlanDraft = useCallback(async (options?: { remapCheckoffLinks?: boolean }) => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("No Working Plan is open");
    if (!workspace.diff.base_is_current) throw new Error("Refresh this Working Plan before acceptance");
    if (
      workspace.reconciliation.kind === "unresolved" &&
      workspace.reconciliation.conflicts.length > 0
    ) {
      throw new Error("Resolve Required-unit changes before acceptance");
    }
    const receipt = await applyPlanDraft(workspace, options);
    setRecentlyAppliedDraftId(workspace.draft.draft_id);
    setActiveDraftId(null);
    queryClient.removeQueries({ queryKey: queryKeys.planDraft(workspace.profile_id, workspace.draft.draft_id), exact: true });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.planDrafts(workspace.profile_id) }),
      invalidatePlanReview(queryClient, workspace.profile_id),
      invalidateProfiles(queryClient),
      queryClient.invalidateQueries({ queryKey: queryKeys.checkoff(workspace.profile_id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.acceptedPlateWorkspace(workspace.profile_id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.acceptedPlateExportJobs(workspace.profile_id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.buildWorkflow(workspace.profile_id) }),
    ]);
    return receipt;
  }, [currentDraftWorkspace, queryClient]);

  const rebaseActivePlanDraft = useCallback(async () => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("No Working Plan is open");
    if (workspace.diff.base_is_current) throw new Error("This Working Plan already uses the Accepted Plan");
    setDraftMutationError(null);
    try {
      const abandoned = workspace.draft.state === "abandoned"
        ? workspace.draft
        : await abandonPlanDraft(workspace.profile_id, workspace.draft);
      if (workspace.draft !== abandoned) {
        storeWorkspace({ ...workspace, draft: abandoned });
      }
      return storeWorkspace(await rebasePlanDraft(workspace.profile_id, abandoned));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDraftMutationError(message);
      throw error;
    }
  }, [currentDraftWorkspace, storeWorkspace]);

  const setSpoolmanSpool = useCallback(
    async (partId: number, spoolman_spool_id: string | null) => {
      if (!review) return;
      setBusyPartId(partId);
      try {
        await patchPartMutation.mutateAsync({
          partId,
          body: { spoolman_spool_id },
        });
      } finally {
        setBusyPartId(null);
      }
    },
    [review, patchPartMutation],
  );

  const toggleUnit = useCallback(
    async (partId: number, unitIndex: number, completed: boolean) => {
      if (!review) return;
      setBusyPartId(partId);
      try {
        await patchProgressMutation.mutateAsync({
          partId,
          unitIndex,
          completed,
          optimisticReview: review,
        });
      } finally {
        setBusyPartId(null);
      }
    },
    [review, patchProgressMutation],
  );

  const toggleAssembled = useCallback(
    async (partId: number, unitIndex: number, assembled: boolean) => {
      if (!review) return;
      setBusyPartId(partId);
      try {
        await patchAssembledMutation.mutateAsync({
          partId,
          unitIndex,
          assembled,
          optimisticReview: review,
        });
      } finally {
        setBusyPartId(null);
      }
    },
    [review, patchAssembledMutation],
  );

  const value = useMemo(
    (): PlanWorkspaceValue => ({
      review,
      draftWorkspace: draftQuery.data ?? null,
      draftLoading: draftListQuery.isLoading || draftQuery.isLoading,
      draftError:
        draftMutationError ??
        (draftQuery.error instanceof Error ? draftQuery.error.message : null) ??
        (draftListQuery.error instanceof Error ? draftListQuery.error.message : null),
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
    <PlanWorkspaceContext.Provider value={value}>{children}</PlanWorkspaceContext.Provider>
  );
}

export function usePlanWorkspace(): PlanWorkspaceValue {
  const ctx = useContext(PlanWorkspaceContext);
  if (!ctx) throw new Error("usePlanWorkspace requires PlanWorkspaceProvider");
  return ctx;
}

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
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  EngineHttpError,
  reconcilePlanDraft,
  rebasePlanDraft,
  recomputePlanDraft,
  type ApplyPlanDraftReceipt,
  type PlanDraftPartDecisionContract,
  type PlanDraftWorkspace,
  type PlanReview,
  type RequiredUnitDecisionContract,
} from "../api/engine";
import { parsePlanDraftWorkspace } from "@print-partner/contracts";
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
import { useProfileSelection } from "./ProfileContext";

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
  setQuantity: (partId: number, partKey: string, qty: number) => Promise<void>;
  setIncluded: (partId: number, partKey: string, included: boolean) => Promise<void>;
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
    if (selectedProfileId == null) throw new Error("Select a Plan before rebuilding");
    setDraftMutationError(null);
    try {
      return storeWorkspace(await recomputePlanDraft(selectedProfileId));
    } catch (error) {
      setDraftMutationError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [selectedProfileId, storeWorkspace]);

  const editActivePlanDraft = useCallback(async (decisions: PlanDraftPartDecisionContract[]) => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("Rebuild the Plan to create a saved draft first");
    try {
      return storeWorkspace(await editPlanDraftParts({
        profileId: workspace.profile_id,
        draftId: workspace.draft.draft_id,
        expectedSnapshotDigest: workspace.draft.snapshot_digest,
        decisions,
      }));
    } catch (error) {
      const replaced = replaceFromConflict(error);
      const message = replaced
        ? "The saved draft changed. Review it and retry this edit."
        : error instanceof Error ? error.message : String(error);
      setDraftMutationError(message);
      throw new Error(message, { cause: error });
    }
  }, [currentDraftWorkspace, replaceFromConflict, storeWorkspace]);

  const editDraft = useCallback(async (
    partId: number,
    partKey: string,
    decision: "included" | "quantity",
    value: boolean | number,
  ) => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("Rebuild the Plan to create a saved draft first");
    const matches = workspace.parts.filter((part) => part.part_key === partKey);
    if (matches.length !== 1) throw new Error("The saved draft no longer has one matching Part");
    setBusyPartId(partId);
    setDraftMutationError(null);
    try {
      await editActivePlanDraft([
        decision === "included"
          ? { kind: "set_included", draft_part_ids: [matches[0]!.draft_part_id], value: Boolean(value) }
          : { kind: "set_quantity_override", draft_part_ids: [matches[0]!.draft_part_id], value: Number(value) },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDraftMutationError(message);
      throw error;
    } finally {
      setBusyPartId(null);
    }
  }, [currentDraftWorkspace, editActivePlanDraft]);

  const setQuantity = useCallback(
    async (partId: number, partKey: string, qty: number) => {
      if (!review) return;
      const clamped = Math.max(1, Math.floor(qty));
      await editDraft(partId, partKey, "quantity", clamped);
    },
    [review, editDraft],
  );

  const setIncluded = useCallback(
    async (partId: number, partKey: string, included: boolean) => {
      if (!review) return;
      await editDraft(partId, partKey, "included", included);
    },
    [review, editDraft],
  );

  const reconcileActivePlanDraft = useCallback(async (decisions: RequiredUnitDecisionContract[]) => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("No saved Plan draft is open");
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
    if (!workspace) throw new Error("No saved Plan draft is open");
    if (!workspace.diff.base_is_current) throw new Error("Rebase this saved draft before Apply");
    if (workspace.reconciliation.kind !== "ready") {
      throw new Error("Resolve Required-unit changes before Apply");
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
    ]);
    return receipt;
  }, [currentDraftWorkspace, queryClient]);

  const rebaseActivePlanDraft = useCallback(async () => {
    const workspace = currentDraftWorkspace();
    if (!workspace) throw new Error("No saved Plan draft is open");
    if (workspace.diff.base_is_current) throw new Error("This saved draft already uses the accepted Plan");
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

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
  parseSavePlanChoicesRequest,
  type ApplyPlanDraftReceipt,
  type PlanDraftPartDecisionContract,
  type PlanDraftWorkspace,
  type RequiredUnitDecisionContract,
  type SavePlanChoicesRequest,
  type PlanDraftIdentity,
} from "@print-partner/contracts";
import { EngineHttpError, randomIdempotencyKey } from "../api/engineTransport";
import { planSaveError, planSaveHasMergeConflict } from "../lib/planSaveError";
import {
  abandonPlanDraft,
  applyPlanDraft,
  editPlanDraftParts,
  fetchPlanDraftWorkspace,
  listPlanDrafts,
  reconcilePlanDraft,
  rebasePlanDraft,
  recomputePlanDraft,
  savePlanChoices,
} from "../api/endpoints/planDrafts";
import { fetchPlanReview, type PlanReview } from "../api/endpoints/planManifests";
import { capturePlanSaveCache, hydratePlanSave, includedPlanReview } from "../lib/planSaveCache";
import { formatCheckoffSummary } from "../lib/checkoffProgress";
import { useEngineHealth } from "../hooks/useEngineHealth";
import {
  invalidatePlanReview,
  usePatchPartAssembledMutation,
  usePatchPartMutation,
  usePatchPartProgressMutation,
  usePlanReviewQuery,
} from "../queries/planReview";
import { refreshProfileSummary } from "../queries/profiles";
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
import { useBuildSaveFlushRegistry } from "./BuildSaveFlushContext";
import {
  usePlanFileChoices,
  type PlanFileChoice,
  type PlanFileChoiceBatch,
} from "../hooks/usePlanFileChoices";

/** The Plan row being edited — enough identity to find it in the saved draft. */
export type PlanEditablePart = PlanRowIdentity & {
  readonly id: number;
  readonly filename: string;
};

export type QuantityUpdate =
  | number
  | ((currentQuantity: number) => number);

type PlanPartChange =
  | { kind: "set_quantity"; part: PlanEditablePart; value: number }
  | { kind: "set_included"; part: PlanEditablePart; value: boolean };

type DraftPartEdit =
  | { kind: "set_included"; value: boolean }
  | { kind: "set_quantity"; value: QuantityUpdate };

type PlanEdits = readonly { part: PlanEditablePart; edit: DraftPartEdit }[];
type PlanChoiceDecision = SavePlanChoicesRequest["decisions"][number];
type PlanChoiceKind = PlanChoiceDecision["kind"];
type PlanChoiceTarget = PlanChoiceDecision["target"];
declare const planChoiceFieldIdentityBrand: unique symbol;
type PlanChoiceFieldIdentity = string & {
  readonly [planChoiceFieldIdentityBrand]: true;
};
type PlanChoiceIntentOrigin =
  | Readonly<{ kind: "direct" }>
  | Readonly<{ kind: "file_choices"; acknowledgeSaved: () => void }>;
type QueuedPlanChoiceIntent = Readonly<{
  id: symbol;
  enqueueOrder: number;
  edits: PlanEdits;
  origin: PlanChoiceIntentOrigin;
}>;
type PendingPlanSave = Readonly<{
  intent: QueuedPlanChoiceIntent;
  request: SavePlanChoicesRequest;
  key: string;
  fields: ReadonlySet<PlanChoiceFieldIdentity>;
}>;
type FailedChoiceBase = Readonly<{
  intentId: symbol;
  remainingFields: ReadonlySet<PlanChoiceFieldIdentity>;
  readonly error: unknown;
  notCorrectableThroughOrder: number;
  failureSequence: number;
}>;
type FailedChoiceIntent = FailedChoiceBase & (
  | Readonly<{
      certainty: "definitive";
      explicitRetryCommand: PendingPlanSave | null;
    }>
  | Readonly<{
      certainty: "uncertain";
      explicitRetryCommand: PendingPlanSave;
    }>
);
type NonChoiceFailureKind = "prepare" | "direct_draft_edit" | "discard";
type NonChoiceFailure = Readonly<{
  kind: NonChoiceFailureKind;
  error: unknown;
  failureSequence: number;
}>;
type DraftEditLane = {
  tail: Promise<void>;
  readonly operations: Set<Promise<unknown>>;
  lastEnqueuedOrder: number;
  lastFailureSequence: number;
  readonly choiceFailures: Map<symbol, FailedChoiceIntent>;
  readonly nonChoiceFailures: Map<NonChoiceFailureKind, NonChoiceFailure>;
};

type UnresolvedDraftError = FailedChoiceIntent | NonChoiceFailure;

type PublishPlanSaveOutcome =
  | Readonly<{ kind: "saved" }>
  | Readonly<{
      kind: "failed";
      certainty: "definitive" | "uncertain";
      error: unknown;
      command: PendingPlanSave;
    }>;

function planChoiceFieldIdentity(
  target: PlanChoiceTarget,
  kind: PlanChoiceKind,
): PlanChoiceFieldIdentity {
  return JSON.stringify([
    target.part_key,
    target.relative_path,
    target.source_layer,
    kind,
  ]) as PlanChoiceFieldIdentity;
}

function planChoiceFields(
  request: SavePlanChoicesRequest,
): ReadonlySet<PlanChoiceFieldIdentity> {
  return new Set(request.decisions.map((decision) =>
    planChoiceFieldIdentity(decision.target, decision.kind)));
}

function planChoiceFieldHints(
  edits: PlanEdits,
): ReadonlySet<PlanChoiceFieldIdentity> {
  return new Set(edits.map(({ part, edit }) => planChoiceFieldIdentity({
    part_key: part.match_key,
    relative_path: part.relative_path,
    source_layer: part.source_layer,
  }, edit.kind === "set_included" ? "set_included" : "set_quantity_override")));
}

function firstUnresolvedDraftError(lane: DraftEditLane | undefined): UnresolvedDraftError | null {
  const failedDiscard = lane?.nonChoiceFailures.get("discard");
  if (failedDiscard != null) return failedDiscard;
  let first: UnresolvedDraftError | null = null;
  for (const failure of lane?.choiceFailures.values() ?? []) {
    if (first == null || failure.failureSequence < first.failureSequence) first = failure;
  }
  for (const failure of lane?.nonChoiceFailures.values() ?? []) {
    if (first == null || failure.failureSequence < first.failureSequence) first = failure;
  }
  return first;
}

function firstUncertainChoiceFailure(lane: DraftEditLane): FailedChoiceIntent & { certainty: "uncertain" } | null {
  let first: (FailedChoiceIntent & { certainty: "uncertain" }) | null = null;
  for (const failure of lane.choiceFailures.values()) {
    if (failure.certainty !== "uncertain") continue;
    if (first == null || failure.failureSequence < first.failureSequence) first = failure;
  }
  return first;
}

function firstChoiceFailure(lane: DraftEditLane): FailedChoiceIntent | null {
  let first: FailedChoiceIntent | null = null;
  for (const failure of lane.choiceFailures.values()) {
    if (first == null || failure.failureSequence < first.failureSequence) first = failure;
  }
  return first;
}

function samePlanEdits(left: PlanEdits, right: PlanEdits): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && item.part.match_key === other.part.match_key &&
      item.part.relative_path === other.part.relative_path && item.part.source_layer === other.part.source_layer &&
      item.edit.kind === other.edit.kind && item.edit.value === other.edit.value;
  });
}

type BuildDraftUiState = Readonly<{
  activeDraftId: number | null;
  recentlyAppliedDraftId: number | null;
  draftMutationError: string | null;
  busyPartId: number | null;
  saving: boolean;
  mergeConflict: boolean;
}>;

const EMPTY_BUILD_DRAFT_UI_STATE: BuildDraftUiState = {
  activeDraftId: null,
  recentlyAppliedDraftId: null,
  draftMutationError: null,
  busyPartId: null,
  saving: false,
  mergeConflict: false,
};

type PlanWorkspaceValue = {
  review: PlanReview | null;
  loading: boolean;
  error: string | null;
  progressSummary: string;
  refresh: () => Promise<void>;
  preparePlan: (options?: { applyManifest?: boolean }) => Promise<void>;
  retryPlanSave: (options?: { applyManifest?: boolean }) => Promise<void>;
  saving: boolean;
  mergeConflict: boolean;
  canDiscardPendingEdits: boolean;
  discardPendingEdits: () => Promise<void>;
  pendingFileChoices: ReadonlyMap<string, PlanFileChoice>;
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
  setFilesIncluded: (parts: readonly PlanEditablePart[], included: boolean) => Promise<void>;
  savePlanPartChanges: (changes: readonly PlanPartChange[]) => Promise<void>;
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
  const draftEditLanesByBuild = useRef(new Map<number, DraftEditLane>());
  const [, setDraftOutcomeRevision] = useState(0);
  const closedDraftIds = useRef(new Set<number>());
  const selectedDraftUi =
    selectedProfileId == null
      ? EMPTY_BUILD_DRAFT_UI_STATE
      : (draftUiByBuild.get(selectedProfileId) ?? EMPTY_BUILD_DRAFT_UI_STATE);
  const {
    activeDraftId,
    recentlyAppliedDraftId,
    draftMutationError,
    busyPartId,
    saving,
    mergeConflict,
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
    const open = latestOpenDraftId(draftListQuery.data?.filter((draft) => !closedDraftIds.current.has(draft.draft_id)), recentlyAppliedDraftId);
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
      refreshProfileSummary(queryClient, selectedProfileId),
    ]);
  }, [health?.ok, queryClient, selectedProfileId]);

  const storeWorkspace = useCallback(
    (workspace: PlanDraftWorkspace, refreshSummaries = true) => {
      updateDraftUi(workspace.profile_id, (current) => ({
        ...current,
        activeDraftId: workspace.draft.draft_id,
      }));
      queryClient.setQueryData(
        queryKeys.planDraft(workspace.profile_id, workspace.draft.draft_id),
        workspace,
      );
      if (refreshSummaries) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.planDrafts(workspace.profile_id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.buildWorkflow(workspace.profile_id) });
      }
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
      const workspace = profileDraftId != null
        ? (queryClient.getQueryData<PlanDraftWorkspace>(
            queryKeys.planDraft(profileId, profileDraftId),
          ) ?? selectedWorkspace)
        : selectedWorkspace;
      return workspace && !closedDraftIds.current.has(workspace.draft.draft_id) ? workspace : undefined;
    },
    [draftQuery.data, queryClient, selectedProfileId],
  );

  const notifyDraftOutcomeChanged = useCallback(() => {
    setDraftOutcomeRevision((revision) => revision + 1);
  }, []);

  const getOrCreateDraftEditLane = useCallback((profileId: number): DraftEditLane => {
    const current = draftEditLanesByBuild.current.get(profileId);
    if (current) return current;
    const lane: DraftEditLane = {
      tail: Promise.resolve(),
      operations: new Set(),
      lastEnqueuedOrder: 0,
      lastFailureSequence: 0,
      choiceFailures: new Map(),
      nonChoiceFailures: new Map(),
    };
    draftEditLanesByBuild.current.set(profileId, lane);
    return lane;
  }, []);

  const deleteEmptyDraftEditLane = useCallback((profileId: number, lane: DraftEditLane) => {
    if (
      draftEditLanesByBuild.current.get(profileId) === lane &&
      lane.operations.size === 0 &&
      lane.choiceFailures.size === 0 &&
      lane.nonChoiceFailures.size === 0
    ) {
      draftEditLanesByBuild.current.delete(profileId);
    }
  }, []);

  const enqueueDraftLaneOperation = useCallback(
    <T,>(profileId: number, run: () => Promise<T>): Promise<T> => {
      const lane = getOrCreateDraftEditLane(profileId);
      const result = lane.tail.then(run);
      lane.tail = result.then(() => undefined, () => undefined);
      lane.operations.add(result);
      void result.finally(() => {
        lane.operations.delete(result);
        deleteEmptyDraftEditLane(profileId, lane);
      }).catch(() => undefined);
      return result;
    },
    [deleteEmptyDraftEditLane, getOrCreateDraftEditLane],
  );

  const enqueueNonChoiceDraftOperation = useCallback(
    <T,>(profileId: number, kind: NonChoiceFailureKind, run: () => Promise<T>): Promise<T> => {
      const lane = getOrCreateDraftEditLane(profileId);
      return enqueueDraftLaneOperation(profileId, async () => {
        try {
          const value = await run();
          if (kind === "discard") {
            lane.choiceFailures.clear();
            lane.nonChoiceFailures.clear();
          } else {
            lane.nonChoiceFailures.delete(kind);
          }
          notifyDraftOutcomeChanged();
          return value;
        } catch (error: unknown) {
          const previous = lane.nonChoiceFailures.get(kind);
          lane.nonChoiceFailures.set(kind, {
            kind,
            error,
            failureSequence: previous?.failureSequence ?? ++lane.lastFailureSequence,
          });
          notifyDraftOutcomeChanged();
          throw error;
        }
      });
    },
    [enqueueDraftLaneOperation, getOrCreateDraftEditLane, notifyDraftOutcomeChanged],
  );

  const enqueueChoiceDraftOperation = useCallback(
    <T,>(
      profileId: number,
      edits: PlanEdits,
      origin: PlanChoiceIntentOrigin,
      run: (intent: QueuedPlanChoiceIntent) => Promise<T>,
    ): Promise<T> => {
      const lane = getOrCreateDraftEditLane(profileId);
      const intent: QueuedPlanChoiceIntent = {
        id: Symbol("plan-choice-intent"),
        enqueueOrder: ++lane.lastEnqueuedOrder,
        edits,
        origin,
      };
      return enqueueDraftLaneOperation(profileId, () => run(intent));
    },
    [enqueueDraftLaneOperation, getOrCreateDraftEditLane],
  );

  const startPlanDraftForProfile = useCallback(
    async (
      profileId: number,
      options?: { applyManifest?: boolean },
      refreshSummaries = true,
      reportMutationError = true,
    ) => {
      if (reportMutationError) {
        updateDraftUi(profileId, (current) => ({
          ...current,
          draftMutationError: null,
        }));
      }
      try {
        return storeWorkspace(await (options ? recomputePlanDraft(profileId, options) : recomputePlanDraft(profileId)), refreshSummaries);
      } catch (error) {
        if (reportMutationError) {
          updateDraftUi(profileId, (current) => ({
            ...current,
            draftMutationError:
              error instanceof Error ? error.message : String(error),
          }));
        }
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
      refreshSummaries = true,
    ) =>
      storeWorkspace(
        await editPlanDraftParts({
          profileId: workspace.profile_id,
          draftId: workspace.draft.draft_id,
          expectedSnapshotDigest: workspace.draft.snapshot_digest,
          decisions,
        }),
        refreshSummaries,
      ),
    [storeWorkspace],
  );

  const editWorkspaceParts = useCallback(
    async (
      workspace: PlanDraftWorkspace,
      decisions: PlanDraftPartDecisionContract[],
      reportMutationError = true,
    ) => {
      if (reportMutationError) {
        updateDraftUi(workspace.profile_id, (current) => ({
          ...current,
          draftMutationError: null,
        }));
      }
      try {
        return await persistDraftEdit(workspace, decisions);
      } catch (error) {
        const replaced = replaceFromConflict(workspace.profile_id, error);
        const message = replaced
          ? "The Working Plan changed. Review it and retry this edit."
          : error instanceof Error
            ? error.message
            : String(error);
        if (reportMutationError) {
          updateDraftUi(workspace.profile_id, (current) => ({
            ...current,
            draftMutationError: message,
          }));
        }
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
      const openDraftId = latestOpenDraftId(drafts.filter((draft) => !closedDraftIds.current.has(draft.draft_id)), recentlyApplied);
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

  const rebaseWorkspace = useCallback(async (workspace: PlanDraftWorkspace) => {
    const next = await rebasePlanDraft(workspace.profile_id, workspace.draft);
    closedDraftIds.current.add(workspace.draft.draft_id);
    return storeWorkspace(next);
  }, [storeWorkspace]);

  const applyWorkspace = useCallback(
    async (workspace: PlanDraftWorkspace, options?: { remapCheckoffLinks?: boolean }) => {
      if (!workspace.diff.base_is_current)
        throw new Error("The Plan changed in another window. Retry to combine it with your saved edits.");
      if (
        workspace.reconciliation.kind === "unresolved" &&
        workspace.reconciliation.conflicts.length > 0
      ) {
        throw new Error("A changed file affects previous print progress. Choose what to keep below.");
      }
      let receipt: ApplyPlanDraftReceipt;
      for (let refreshAttempt = 0; ; refreshAttempt += 1) {
        try {
          receipt = await applyPlanDraft(workspace, options);
          break;
        } catch (error) {
          if (isWorkingPlanInputsChanged(error) && refreshAttempt < 2) {
            workspace = await rebaseWorkspace(workspace);
            continue;
          }
          if (replaceFromConflict(workspace.profile_id, error)) {
            throw new WorkingPlanChangedError("refreshed", { cause: error });
          }
          throw error;
        }
      }
      closedDraftIds.current.add(workspace.draft.draft_id);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.planDrafts(workspace.profile_id),
        }),
        queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] === "planReview" && query.queryKey[1] === workspace.profile_id,
          refetchType: "all",
        }, { throwOnError: true }),
        refreshProfileSummary(queryClient, workspace.profile_id),
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
      ]).finally(() => {
        updateDraftUi(workspace.profile_id, (current) => ({
          ...current,
          recentlyAppliedDraftId: workspace.draft.draft_id,
          activeDraftId: current.activeDraftId === workspace.draft.draft_id ? null : current.activeDraftId,
        }));
      });
      queryClient.removeQueries({
        queryKey: queryKeys.planDraft(workspace.profile_id, workspace.draft.draft_id),
        exact: true,
      });
      return receipt;
    },
    [
      queryClient,
      replaceFromConflict,
      rebaseWorkspace,
      updateDraftUi,
    ],
  );

  const prepareCurrentPlan = useCallback((options?: { applyManifest?: boolean }) => {
    const profileId = selectedProfileId;
    if (profileId == null) return Promise.reject(new Error("Choose a Build first"));
    return enqueueNonChoiceDraftOperation(profileId, "prepare", async () => {
      updateDraftUi(profileId, (current) => ({ ...current, saving: true, draftMutationError: null, mergeConflict: false }));
      try {
        let workspace = await resolveOpenDraftWorkspace(profileId);
        if (workspace && (!workspace.diff.base_is_current || workspace.draft.state === "abandoned")) {
          workspace = await rebaseWorkspace(workspace);
        }
        if (workspace && options?.applyManifest) {
          await applyWorkspace(workspace, { remapCheckoffLinks: true });
          workspace = null;
        }
        workspace ??= await startPlanDraftForProfile(profileId, options, true, false);
        if (workspace.draft.base.revision_id != null && workspace.diff.base_is_current &&
            workspace.diff.added.length === 0 && workspace.diff.changed.length === 0 && workspace.diff.removed.length === 0) {
          await abandonPlanDraft(profileId, workspace.draft);
          closedDraftIds.current.add(workspace.draft.draft_id);
          updateDraftUi(profileId, (current) => ({ ...current, activeDraftId: null, recentlyAppliedDraftId: workspace.draft.draft_id }));
          queryClient.removeQueries({ queryKey: queryKeys.planDraft(profileId, workspace.draft.draft_id), exact: true });
          await queryClient.invalidateQueries({ queryKey: queryKeys.planDrafts(profileId) });
        } else {
          await applyWorkspace(workspace, { remapCheckoffLinks: true });
        }
      } catch (error) {
        updateDraftUi(profileId, (current) => ({ ...current, mergeConflict: planSaveHasMergeConflict(error) }));
        throw error;
      } finally {
        updateDraftUi(profileId, (current) => ({ ...current, saving: false }));
      }
    });
  }, [applyWorkspace, enqueueNonChoiceDraftOperation, queryClient, rebaseWorkspace, resolveOpenDraftWorkspace, selectedProfileId, startPlanDraftForProfile, updateDraftUi]);

  const editActivePlanDraft = useCallback(
    (decisions: PlanDraftPartDecisionContract[]) => {
      const profileId = selectedProfileId;
      if (profileId == null)
        return Promise.reject(
          new Error("Select a Build before editing its Working Plan"),
        );
      return enqueueNonChoiceDraftOperation(profileId, "direct_draft_edit", async () => {
        const workspace = await resolveOpenDraftWorkspace(profileId);
        if (!workspace)
          throw new Error("Create a Working Plan from Sources first");
        return editWorkspaceParts(workspace, decisions, false);
      });
    },
    [
      editWorkspaceParts,
      enqueueNonChoiceDraftOperation,
      resolveOpenDraftWorkspace,
      selectedProfileId,
    ],
  );

  const recordChoiceFailure = useCallback((
    lane: DraftEditLane,
    intent: QueuedPlanChoiceIntent,
    fields: ReadonlySet<PlanChoiceFieldIdentity>,
    error: unknown,
    failedCommand: PublishPlanSaveOutcome & { kind: "failed" } | null,
  ) => {
    const previous = lane.choiceFailures.get(intent.id);
    const base = {
      intentId: intent.id,
      remainingFields: previous?.remainingFields ?? fields,
      error,
      notCorrectableThroughOrder:
        previous?.notCorrectableThroughOrder ?? lane.lastEnqueuedOrder,
      failureSequence:
        previous?.failureSequence ?? ++lane.lastFailureSequence,
    };
    lane.choiceFailures.set(intent.id, failedCommand?.certainty === "uncertain"
      ? {
          ...base,
          certainty: "uncertain",
          explicitRetryCommand: failedCommand.command,
        }
      : {
          ...base,
          certainty: "definitive",
          explicitRetryCommand:
            failedCommand?.command ?? previous?.explicitRetryCommand ?? null,
        });
    notifyDraftOutcomeChanged();
  }, [notifyDraftOutcomeChanged]);

  const acknowledgeExactReplay = useCallback((
    lane: DraftEditLane,
    failure: FailedChoiceIntent,
  ) => {
    lane.choiceFailures.delete(failure.intentId);
    if (failure.explicitRetryCommand?.intent.origin.kind === "file_choices") {
      failure.explicitRetryCommand.intent.origin.acknowledgeSaved();
    }
    notifyDraftOutcomeChanged();
  }, [notifyDraftOutcomeChanged]);

  const acknowledgeSuccessfulCorrection = useCallback((
    lane: DraftEditLane,
    intent: QueuedPlanChoiceIntent,
    fields: ReadonlySet<PlanChoiceFieldIdentity>,
  ) => {
    for (const [intentId, failure] of lane.choiceFailures) {
      if (
        failure.certainty !== "definitive" ||
        intent.enqueueOrder <= failure.notCorrectableThroughOrder
      ) {
        continue;
      }
      const remainingFields = new Set(
        [...failure.remainingFields].filter((field) => !fields.has(field)),
      );
      if (remainingFields.size === 0) lane.choiceFailures.delete(intentId);
      else lane.choiceFailures.set(intentId, { ...failure, remainingFields });
    }
    if (intent.origin.kind === "file_choices") intent.origin.acknowledgeSaved();
    notifyDraftOutcomeChanged();
  }, [notifyDraftOutcomeChanged]);

  const publishPendingPlanSave = useCallback(async (
    profileId: number,
    command: PendingPlanSave,
  ): Promise<PublishPlanSaveOutcome> => {
    for (let retry = 0; ; retry += 1) {
      try {
        const observed = capturePlanSaveCache(queryClient, profileId);
        const saved = await savePlanChoices(profileId, command.request, command.key);
        await hydratePlanSave(queryClient, saved, observed);
        for (const id of saved.closed_draft_ids) closedDraftIds.current.add(id);
        updateDraftUi(profileId, (current) => ({
          ...current,
          recentlyAppliedDraftId: saved.receipt.draft_id,
          activeDraftId: current.activeDraftId != null && saved.closed_draft_ids.includes(current.activeDraftId)
            ? null : current.activeDraftId,
        }));
        return { kind: "saved" };
      } catch (error) {
        const definitive = error instanceof EngineHttpError && error.status < 500 && error.status !== 408;
        if (!definitive && retry === 0) continue;
        return {
          kind: "failed",
          certainty: definitive ? "definitive" : "uncertain",
          error,
          command,
        };
      }
    }
  }, [queryClient, updateDraftUi]);

  const editDraft = useCallback(
    (
      edits: PlanEdits,
      profileId = selectedProfileId,
      origin: PlanChoiceIntentOrigin = { kind: "direct" },
    ) => {
      if (edits.length === 0) return Promise.resolve();
      if (profileId == null)
        return Promise.reject(
          new Error("Select a Build before editing its Working Plan"),
        );
      return enqueueChoiceDraftOperation(profileId, edits, origin, async (intent) => {
        const lane = getOrCreateDraftEditLane(profileId);
        updateDraftUi(profileId, (current) => ({
          ...current,
          busyPartId: edits[0]?.part.id ?? null,
          saving: true,
          mergeConflict: false,
        }));
        let failureAlreadyRecorded = false;
        let command: PendingPlanSave | null = null;
        let failedCommand: (PublishPlanSaveOutcome & { kind: "failed" }) | null = null;
        try {
          const uncertain = firstUncertainChoiceFailure(lane);
          if (uncertain) {
            const replay = await publishPendingPlanSave(
              profileId,
              uncertain.explicitRetryCommand,
            );
            if (replay.kind === "failed") {
              const replayError = new Error(planSaveError(replay.error), { cause: replay.error });
              recordChoiceFailure(
                lane,
                uncertain.explicitRetryCommand.intent,
                uncertain.remainingFields,
                replayError,
                replay,
              );
              updateDraftUi(profileId, (current) => ({
                ...current,
                mergeConflict: planSaveHasMergeConflict(replay.error),
              }));
              failureAlreadyRecorded = true;
              throw replayError;
            }
            acknowledgeExactReplay(lane, uncertain);
            if (samePlanEdits(uncertain.explicitRetryCommand.intent.edits, edits)) return;
          }

          let fields = planChoiceFieldHints(edits);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            failedCommand = null;
            try {
              let workspace = currentDraftWorkspace(profileId);
              if (workspace && (!workspace.diff.base_is_current || workspace.draft.state === "abandoned")) {
                workspace = await rebaseWorkspace(workspace);
              }
              const drafts = queryClient.getQueryData<PlanDraftIdentity[]>(queryKeys.planDrafts(profileId)) ??
                (profileId === selectedProfileId ? draftListQuery.data : undefined);
              const draftId = latestOpenDraftId(drafts?.filter((draft) => !closedDraftIds.current.has(draft.draft_id)));
              const draft = workspace?.draft ?? drafts?.find((item) => item.draft_id === draftId) ?? null;
              if (!workspace && draft && edits.some(({ edit }) => edit.kind === "set_quantity" && typeof edit.value === "function")) {
                workspace = storeWorkspace(await fetchPlanDraftWorkspace(profileId, draft.draft_id), false);
              }
              const currentReview = queryClient.getQueryData<PlanReview>(queryKeys.planReview(profileId, true)) ??
                queryClient.getQueryData<PlanReview>(queryKeys.planReview(profileId, false)) ??
                (profileId === selectedProfileId ? review : null);
              const expectedDraft = workspace?.draft ?? draft;
              const accepted = currentReview?.accepted_basis;
              const request: SavePlanChoicesRequest = {
                expected_base: expectedDraft?.base ?? {
                  revision_id: accepted?.plan_revision_id ?? null,
                  plan_version: accepted?.plan_version ?? 0,
                },
                expected_draft: expectedDraft,
                remap_checkoff_links: true,
                decisions: edits.map(({ part, edit }) => {
                  const target = { part_key: part.match_key, relative_path: part.relative_path, source_layer: part.source_layer };
                  if (edit.kind === "set_included") {
                    if (workspace) {
                      const match = resolveDraftPart(workspace.parts, part);
                      if (match.kind !== "resolved") throw new Error(draftPartMatchError(match, part.filename));
                    }
                    return { kind: "set_included", target, value: edit.value };
                  }
                  const candidates: readonly { part_key: string; relative_path: string; source_layer: string | null; quantity_effective: number }[] = workspace?.parts ?? currentReview?.part_groups.flatMap((group) =>
                    group.parts.map((row) => ({ ...row, part_key: row.match_key }))) ?? [];
                  const match = resolveDraftPart(candidates, part);
                  if (match.kind !== "resolved") throw new Error(draftPartMatchError(match, part.filename));
                  return {
                    kind: "set_quantity_override", target,
                    value: Math.max(1, Math.floor(typeof edit.value === "function"
                      ? edit.value(match.part.quantity_effective) : edit.value)),
                  };
                }),
              };
              const parsedRequest = parseSavePlanChoicesRequest(request);
              fields = planChoiceFields(parsedRequest);
              command = {
                intent,
                request: parsedRequest,
                key: randomIdempotencyKey(),
                fields,
              };
              const outcome = await publishPendingPlanSave(profileId, command);
              if (outcome.kind === "saved") {
                acknowledgeSuccessfulCorrection(lane, intent, fields);
                return;
              }
              failedCommand = outcome;
              throw outcome.error;
            } catch (error) {
              if (attempt < 2 && error instanceof EngineHttpError && error.status === 409) {
                const replaced = replaceFromConflict(profileId, error);
                if (replaced && !isWorkingPlanInputsChanged(error)) continue;
                const body = error.body;
                const code = body && typeof body === "object" && "code" in body ? body.code : null;
                if (code === "inputs_changed" || code === "base_changed" || code === "draft_changed") {
                  const open = currentDraftWorkspace(profileId) ?? await resolveOpenDraftWorkspace(profileId);
                  if (open && (code === "inputs_changed" || !open.diff.base_is_current)) {
                    await rebaseWorkspace(open);
                  } else {
                    const refreshed = await fetchPlanReview(profileId, { includeExcluded: true });
                    queryClient.setQueryData(queryKeys.planReview(profileId, true), refreshed);
                    if (open) storeWorkspace(await fetchPlanDraftWorkspace(profileId, open.draft.draft_id), false);
                  }
                  continue;
                }
              }
              throw error;
            }
          }
        } catch (error) {
          if (failureAlreadyRecorded) throw error;
          const displayError = new Error(planSaveError(error), { cause: error });
          recordChoiceFailure(
            lane,
            intent,
            command?.fields ?? planChoiceFieldHints(edits),
            displayError,
            failedCommand,
          );
          updateDraftUi(profileId, (current) => ({
            ...current,
            mergeConflict: planSaveHasMergeConflict(error),
          }));
          throw displayError;
        } finally {
          updateDraftUi(profileId, (current) => ({
            ...current,
            busyPartId: null,
            saving: false,
          }));
        }
      });
    },
    [
      acknowledgeExactReplay,
      acknowledgeSuccessfulCorrection,
      currentDraftWorkspace,
      draftListQuery.data,
      enqueueChoiceDraftOperation,
      getOrCreateDraftEditLane,
      queryClient,
      recordChoiceFailure,
      publishPendingPlanSave,
      rebaseWorkspace,
      replaceFromConflict,
      resolveOpenDraftWorkspace,
      review,
      selectedProfileId,
      storeWorkspace,
      updateDraftUi,
    ],
  );

  const setQuantity = useCallback(
    async (part: PlanEditablePart, update: QuantityUpdate) => {
      if (!review) return;
      await editDraft([{ part, edit: { kind: "set_quantity", value: update } }]);
    },
    [review, editDraft],
  );

  const savePlanPartChanges = useCallback(
    (changes: readonly PlanPartChange[]) => editDraft(
      changes.map((change): PlanEdits[number] => ({
        part: change.part,
        edit: change.kind === "set_quantity"
          ? { kind: "set_quantity", value: change.value }
          : { kind: "set_included", value: change.value },
      })),
    ),
    [editDraft],
  );

  const saveFileChoices = useCallback(
    (profileId: number, batch: PlanFileChoiceBatch) => editDraft(
      batch.choices.map((choice) => ({ part: choice.part, edit: { kind: "set_included", value: choice.included } })),
      profileId,
      { kind: "file_choices", acknowledgeSaved: batch.acknowledgeSaved },
    ),
    [editDraft],
  );
  const { choices: pendingFileChoices, saving: savingFiles, select: setFilesIncluded, flush: flushFileChoices, hasPending: hasPendingFileChoices, discard: discardFileChoices } = usePlanFileChoices(selectedProfileId, saveFileChoices);
  const registerBuildSaveFlush = useBuildSaveFlushRegistry();
  const retryFailedChoice = useCallback((
    profileId: number,
    selectedFailure: FailedChoiceIntent,
  ): Promise<void> => enqueueDraftLaneOperation(profileId, async () => {
    const lane = getOrCreateDraftEditLane(profileId);
    const failure = lane.choiceFailures.get(selectedFailure.intentId);
    if (failure == null) return;
    const command = failure.explicitRetryCommand;
    if (command == null) throw failure.error;
    updateDraftUi(profileId, (current) => ({
      ...current,
      busyPartId: command.intent.edits[0]?.part.id ?? null,
      saving: true,
      mergeConflict: false,
    }));
    try {
      const outcome = await publishPendingPlanSave(profileId, command);
      if (outcome.kind === "saved") {
        acknowledgeExactReplay(lane, failure);
        return;
      }
      const displayError = new Error(planSaveError(outcome.error), {
        cause: outcome.error,
      });
      recordChoiceFailure(
        lane,
        command.intent,
        failure.remainingFields,
        displayError,
        outcome,
      );
      updateDraftUi(profileId, (current) => ({
        ...current,
        mergeConflict: planSaveHasMergeConflict(outcome.error),
      }));
      throw displayError;
    } finally {
      updateDraftUi(profileId, (current) => ({
        ...current,
        busyPartId: null,
        saving: false,
      }));
    }
  }), [
    acknowledgeExactReplay,
    enqueueDraftLaneOperation,
    getOrCreateDraftEditLane,
    publishPendingPlanSave,
    recordChoiceFailure,
    updateDraftUi,
  ]);
  const flushDraftEdits = useCallback(async (profileId: number) => {
    while (true) {
      const lane = draftEditLanesByBuild.current.get(profileId);
      if (lane && lane.operations.size > 0) {
        await Promise.allSettled([...lane.operations]);
        continue;
      }
      const uncertain = lane ? firstUncertainChoiceFailure(lane) : null;
      if (uncertain) {
        await editDraft(uncertain.explicitRetryCommand.intent.edits, profileId);
        continue;
      }
      const settledLane = draftEditLanesByBuild.current.get(profileId);
      if (settledLane && settledLane.operations.size > 0) continue;
      const failure = firstUnresolvedDraftError(settledLane);
      if (failure != null) throw failure.error;
      return;
    }
  }, [editDraft]);
  const flushPlanChanges = useCallback(async (profileId: number) => {
    await flushDraftEdits(profileId);
    await flushFileChoices(profileId);
    await flushDraftEdits(profileId);
  }, [flushDraftEdits, flushFileChoices]);
  useEffect(() => {
    if (selectedProfileId == null) return;
    const profileId = selectedProfileId;
    return registerBuildSaveFlush(profileId, () => flushPlanChanges(profileId));
  }, [flushPlanChanges, registerBuildSaveFlush, selectedProfileId]);
  const setIncluded = useCallback((part: PlanEditablePart, included: boolean) => setFilesIncluded([part], included), [setFilesIncluded]);
  const preparePlan = useCallback(async (options?: { applyManifest?: boolean }) => {
    const lane = selectedProfileId == null ? null : draftEditLanesByBuild.current.get(selectedProfileId);
    const failedChoice = lane == null ? null : firstChoiceFailure(lane);
    if (failedChoice && selectedProfileId != null) {
      if (failedChoice.certainty === "definitive") throw failedChoice.error;
      await retryFailedChoice(selectedProfileId, failedChoice);
      if (!options?.applyManifest) return;
    }
    if (selectedProfileId != null && hasPendingFileChoices(selectedProfileId)) {
      await flushFileChoices(selectedProfileId, true);
      if (!options?.applyManifest) return;
    }
    await prepareCurrentPlan(options);
  }, [flushFileChoices, hasPendingFileChoices, prepareCurrentPlan, retryFailedChoice, selectedProfileId]);
  const retryPlanSave = useCallback(async (options?: { applyManifest?: boolean }) => {
    const lane = selectedProfileId == null ? null : draftEditLanesByBuild.current.get(selectedProfileId);
    const failedChoice = lane == null ? null : firstChoiceFailure(lane);
    if (failedChoice && selectedProfileId != null) {
      await retryFailedChoice(selectedProfileId, failedChoice);
      if (!options?.applyManifest) return;
    }
    await preparePlan(options);
  }, [preparePlan, retryFailedChoice, selectedProfileId]);

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

  const applyActivePlanDraft = useCallback(async (options?: { remapCheckoffLinks?: boolean }) => {
    if (selectedProfileId == null) throw new Error("No Plan is open");
    const workspace = currentDraftWorkspace(selectedProfileId);
    if (!workspace) throw new Error("No Plan changes to save");
    return applyWorkspace(workspace, options);
  }, [applyWorkspace, currentDraftWorkspace, selectedProfileId]);

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
      return await rebaseWorkspace(workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateDraftUi(workspace.profile_id, (current) => ({
        ...current,
        draftMutationError: message,
      }));
      throw error;
    }
  }, [currentDraftWorkspace, rebaseWorkspace, selectedProfileId, updateDraftUi]);

  const discardPendingEdits = useCallback(() => {
    const profileId = selectedProfileId;
    if (profileId == null) return Promise.reject(new Error("Choose a Build first"));
    return enqueueNonChoiceDraftOperation(profileId, "discard", async () => {
      updateDraftUi(profileId, (current) => ({ ...current, saving: true }));
      try {
        const lane = getOrCreateDraftEditLane(profileId);
        const ambiguousSave = firstUncertainChoiceFailure(lane) != null;
        const workspace = await resolveOpenDraftWorkspace(profileId);
        if (workspace) {
          await abandonPlanDraft(profileId, workspace.draft);
          closedDraftIds.current.add(workspace.draft.draft_id);
          queryClient.removeQueries({ queryKey: queryKeys.planDraft(profileId, workspace.draft.draft_id), exact: true });
        }
        if (ambiguousSave) {
          await queryClient.cancelQueries({ queryKey: ["planReview", profileId] }, { revert: false });
          const accepted = await fetchPlanReview(profileId, { includeExcluded: true });
          queryClient.setQueryData(queryKeys.planReview(profileId, true), accepted);
          queryClient.setQueryData(queryKeys.planReview(profileId, false), includedPlanReview(accepted));
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.planDrafts(profileId) }),
          ...(ambiguousSave ? [] : [invalidatePlanReview(queryClient, profileId)]),
          queryClient.invalidateQueries({ queryKey: queryKeys.buildWorkflow(profileId) }),
        ]);
        discardFileChoices(profileId);
        updateDraftUi(profileId, (current) => ({ ...current, activeDraftId: null, draftMutationError: null, mergeConflict: false }));
      } finally {
        updateDraftUi(profileId, (current) => ({ ...current, saving: false }));
      }
    });
  }, [discardFileChoices, enqueueNonChoiceDraftOperation, getOrCreateDraftEditLane, queryClient, resolveOpenDraftWorkspace, selectedProfileId, updateDraftUi]);

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

  const selectedUnresolvedDraftError = selectedProfileId == null
    ? null
    : firstUnresolvedDraftError(draftEditLanesByBuild.current.get(selectedProfileId));

  const value = useMemo(
    (): PlanWorkspaceValue => ({
      review,
      draftWorkspace: draftQuery.data ?? null,
      draftLoading: draftListQuery.isLoading || draftQuery.isLoading,
      draftError:
        (selectedUnresolvedDraftError != null
          ? planSaveError(selectedUnresolvedDraftError.error)
          : null) ??
        draftMutationError ??
        (draftQuery.error instanceof Error ? draftQuery.error.message : null) ??
        (draftListQuery.error instanceof Error
          ? draftListQuery.error.message
          : null),
      startPlanDraft,
      preparePlan,
      retryPlanSave,
      saving: saving || savingFiles,
      pendingFileChoices,
      mergeConflict,
      canDiscardPendingEdits:
        mergeConflict || selectedUnresolvedDraftError != null,
      discardPendingEdits,
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
      setFilesIncluded,
      savePlanPartChanges,
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
      selectedUnresolvedDraftError,
      startPlanDraft,
      preparePlan,
      retryPlanSave,
      saving,
      savingFiles,
      pendingFileChoices,
      mergeConflict,
      discardPendingEdits,
      applyActivePlanDraft,
      rebaseActivePlanDraft,
      reconcileActivePlanDraft,
      editActivePlanDraft,
      isLoading,
      queryError,
      refresh,
      setQuantity,
      setIncluded,
      setFilesIncluded,
      savePlanPartChanges,
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

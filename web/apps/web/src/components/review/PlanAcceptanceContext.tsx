import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RequiredUnitDecisionContract } from "@print-partner/contracts";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { useProfileSelection } from "../../context/ProfileContext";
import { useBuildPlanningQuery } from "../build/useBuildPlanningQuery";
import {
  planAcceptanceModel,
  preservedVerifiedUnits,
  type PlanAcceptanceFailure,
  type PlanAcceptanceModel,
} from "../../lib/planAcceptanceModel";
import { planAcceptanceFailureFromError, unmovedUnits } from "../../lib/planAcceptanceFailure";
import {
  clearPlanAcceptance,
  readPlanAcceptance,
  writePlanAcceptance,
  type StoredPlanAcceptance,
} from "../../lib/planAcceptanceReceipt";

export type PlanAcceptanceValue = {
  readonly model: PlanAcceptanceModel;
  readonly buildId: number | null;
  readonly busy: boolean;
  readonly failure: PlanAcceptanceFailure | null;
  /** Required-unit answers the user has picked but not saved yet. */
  readonly decisionChoices: Readonly<Record<number, string>>;
  readonly decisionsComplete: boolean;
  readonly confirmation: StoredPlanAcceptance | null;
  readonly syncBusy: boolean;
  chooseDecision: (draftPartId: number, choice: string) => void;
  saveDecisions: () => void;
  refreshWorkingPlan: () => void;
  accept: (options?: { moveLinkedRecords?: boolean }) => void;
  dismissConfirmation: () => void;
  syncSources: () => void;
};

const PlanAcceptanceContext = createContext<PlanAcceptanceValue | null>(null);

type ProviderProps = {
  readonly children: ReactNode;
  readonly onSyncSources?: () => void;
  readonly syncBusy?: boolean;
};

export function PlanAcceptanceProvider({ children, onSyncSources, syncBusy }: ProviderProps) {
  const { selectedProfileId, profiles } = useProfileSelection();
  const {
    review,
    draftWorkspace,
    applyActivePlanDraft,
    rebaseActivePlanDraft,
    reconcileActivePlanDraft,
  } = usePlanWorkspace();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlanAcceptanceFailure | null>(null);
  const [decisionChoices, setDecisionChoices] = useState<Record<number, string>>({});
  const [confirmation, setConfirmation] = useState<StoredPlanAcceptance | null>(null);
  const planningQuery = useBuildPlanningQuery(
    selectedProfileId,
    draftWorkspace?.draft.draft_id ?? null,
  );

  // A saved Working Plan that changes underneath invalidates earlier answers.
  useEffect(() => {
    setDecisionChoices({});
    setFailure(null);
  }, [draftWorkspace?.draft.snapshot_digest]);

  useEffect(() => {
    setConfirmation(readPlanAcceptance(selectedProfileId));
  }, [selectedProfileId]);

  const freshness =
    profiles.find((profile) => profile.id === selectedProfileId)?.freshness ?? null;

  const model = useMemo(
    () => planAcceptanceModel({
      review,
      draft: draftWorkspace,
      buildId: selectedProfileId,
      failure,
      freshness,
      planningBlockers: planningQuery.data?.acceptance_readiness?.blockers,
    }),
    [draftWorkspace, failure, freshness, planningQuery.data, review, selectedProfileId],
  );

  const conflicts = draftWorkspace?.reconciliation.kind === "unresolved"
    ? draftWorkspace.reconciliation.conflicts
    : [];
  const decisionsComplete =
    conflicts.length > 0 &&
    conflicts.every((conflict) => Boolean(decisionChoices[conflict.target_draft_part_id]));

  const chooseDecision = useCallback((draftPartId: number, choice: string) => {
    setDecisionChoices((current) => ({ ...current, [draftPartId]: choice }));
  }, []);

  const saveDecisions = useCallback(() => {
    if (draftWorkspace?.reconciliation.kind !== "unresolved") return;
    const decisions: RequiredUnitDecisionContract[] = [];
    for (const conflict of draftWorkspace.reconciliation.conflicts) {
      const choice = decisionChoices[conflict.target_draft_part_id];
      if (!choice) return;
      if (choice === "replace") {
        decisions.push({ kind: "replace", target_draft_part_id: conflict.target_draft_part_id });
      } else if (conflict.kind === "ambiguous_exact_match") {
        decisions.push({
          kind: "select_exact_predecessor",
          target_draft_part_id: conflict.target_draft_part_id,
          predecessor_revision_part_id: Number(choice),
        });
      } else {
        decisions.push({
          kind: "accept_prior_completion",
          target_draft_part_id: conflict.target_draft_part_id,
          predecessor_revision_part_id: conflict.predecessor_revision_part_id,
        });
      }
    }
    setBusy(true);
    setFailure(null);
    void reconcileActivePlanDraft(decisions)
      .catch((error: unknown) => setFailure(planAcceptanceFailureFromError(error)))
      .finally(() => setBusy(false));
  }, [decisionChoices, draftWorkspace, reconcileActivePlanDraft]);

  const refreshWorkingPlan = useCallback(() => {
    setBusy(true);
    setFailure(null);
    void rebaseActivePlanDraft()
      .catch((error: unknown) => setFailure(planAcceptanceFailureFromError(error)))
      .finally(() => setBusy(false));
  }, [rebaseActivePlanDraft]);

  const accept = useCallback((options?: { moveLinkedRecords?: boolean }) => {
    const workspace = draftWorkspace;
    if (!workspace || selectedProfileId == null) return;
    const included = workspace.parts.filter((part) => part.included);
    const requiredUnits = included.reduce(
      (sum, part) => sum + Math.max(0, part.quantity_effective),
      0,
    );
    const verifiedUnits = preservedVerifiedUnits({
      accepted: model.accepted,
      draft: workspace,
    });
    const carried = unmovedUnits(failure);
    setBusy(true);
    setFailure(null);
    void applyActivePlanDraft(
      options?.moveLinkedRecords ? { remapCheckoffLinks: true } : undefined,
    )
      .then((receipt) => {
        const stored: StoredPlanAcceptance = {
          buildId: selectedProfileId,
          planVersion: receipt.plan_version,
          requiredUnits,
          verifiedUnits,
          remainingUnits: Math.max(0, requiredUnits - verifiedUnits),
          unmoved: carried,
          acceptedAt: receipt.applied_at,
        };
        writePlanAcceptance(stored);
        setConfirmation(stored);
      })
      .catch((error: unknown) => setFailure(planAcceptanceFailureFromError(error)))
      .finally(() => setBusy(false));
  }, [applyActivePlanDraft, draftWorkspace, failure, model.accepted, selectedProfileId]);

  const dismissConfirmation = useCallback(() => {
    clearPlanAcceptance(selectedProfileId);
    setConfirmation(null);
  }, [selectedProfileId]);

  const syncSources = useCallback(() => {
    onSyncSources?.();
  }, [onSyncSources]);

  const value = useMemo(
    (): PlanAcceptanceValue => ({
      model,
      buildId: selectedProfileId,
      busy,
      failure,
      decisionChoices,
      decisionsComplete,
      confirmation,
      syncBusy: Boolean(syncBusy),
      chooseDecision,
      saveDecisions,
      refreshWorkingPlan,
      accept,
      dismissConfirmation,
      syncSources,
    }),
    [
      accept,
      busy,
      chooseDecision,
      confirmation,
      decisionChoices,
      decisionsComplete,
      dismissConfirmation,
      failure,
      model,
      refreshWorkingPlan,
      saveDecisions,
      selectedProfileId,
      syncBusy,
      syncSources,
    ],
  );

  return (
    <PlanAcceptanceContext.Provider value={value}>{children}</PlanAcceptanceContext.Provider>
  );
}

export function usePlanAcceptance(): PlanAcceptanceValue {
  const value = useContext(PlanAcceptanceContext);
  if (!value) throw new Error("usePlanAcceptance requires PlanAcceptanceProvider");
  return value;
}

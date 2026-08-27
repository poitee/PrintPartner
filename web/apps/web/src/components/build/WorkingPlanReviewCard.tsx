import type { RequiredUnitDecisionContract } from "@print-partner/contracts";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import {
  planDraftProductionBlockFromError,
  planDraftRevisionPartLabels,
  type ProductionBlock,
} from "../../lib/planDraftUi";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import PlanDraftApplyButton from "./PlanDraftApplyButton";

const NO_CHANGED_FIELDS: string[] = [];

export default function WorkingPlanReviewCard() {
  const {
    draftWorkspace,
    applyActivePlanDraft,
    rebaseActivePlanDraft,
    reconcileActivePlanDraft,
  } = usePlanWorkspace();
  const [busy, setBusy] = useState(false);
  const [conflictChoices, setConflictChoices] = useState<Record<string, string>>({});
  const [productionBlock, setProductionBlock] = useState<ProductionBlock | null>(null);

  useEffect(() => {
    setConflictChoices({});
    setProductionBlock(null);
  }, [draftWorkspace?.draft.snapshot_digest]);

  const acceptedRevisionPartLabels = useMemo(
    () => draftWorkspace
      ? planDraftRevisionPartLabels(draftWorkspace)
      : new Map<number, string>(),
    [draftWorkspace],
  );
  const proposedPartChanges = useMemo(() => {
    if (!draftWorkspace) return [];
    const added = draftWorkspace.diff.added.map((part) => ({
      part,
      label: "Added",
      fields: NO_CHANGED_FIELDS,
    }));
    const changed = draftWorkspace.diff.changed.map((change) => ({
      part: change.after,
      label: "Changed",
      fields: change.fields,
    }));
    return [...added, ...changed];
  }, [draftWorkspace]);

  if (!draftWorkspace) return null;

  const onAccept = async (options?: { remapCheckoffLinks?: boolean }) => {
    setBusy(true);
    try {
      const receipt = await applyActivePlanDraft(options);
      setProductionBlock(null);
      toast.success(`Accepted Plan version ${receipt.plan_version}`);
    } catch (error) {
      const blocked = planDraftProductionBlockFromError(error);
      if (blocked) {
        setProductionBlock(blocked);
        toast.error(
          `${blocked.checkoffLinkCount} Checkoff record(s) are linked to the Accepted Plan. Remap them during acceptance or resolve Production first.`,
        );
      } else {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const onRefresh = async () => {
    setBusy(true);
    try {
      await rebaseActivePlanDraft();
      toast.success("Working Plan refreshed from the Accepted Plan");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onResolve = async () => {
    if (draftWorkspace.reconciliation.kind !== "unresolved") return;
    const decisions: RequiredUnitDecisionContract[] = [];
    for (const conflict of draftWorkspace.reconciliation.conflicts) {
      const key = `${conflict.kind}:${conflict.target_draft_part_id}`;
      const choice = conflictChoices[key];
      if (!choice) {
        toast.error("Choose how to resolve every Required-unit conflict");
        return;
      }
      if (choice === "replace") {
        decisions.push({
          kind: "replace",
          target_draft_part_id: conflict.target_draft_part_id,
        });
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
    try {
      await reconcileActivePlanDraft(decisions);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <CardTitle level={3} className="text-base">Working Plan</CardTitle>
        <CardDescription>
          Review these changes before acceptance. The Accepted Plan and Checkoff stay unchanged until then.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          {draftWorkspace.diff.added.length} added, {draftWorkspace.diff.changed.length} changed, {draftWorkspace.diff.removed.length} removed
        </p>
        {(proposedPartChanges.length > 0 || draftWorkspace.diff.removed.length > 0) && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Working Plan Part</th>
                  <th className="px-3 py-2 font-medium">Change</th>
                  <th className="px-3 py-2 font-medium">Proposed qty</th>
                  <th className="px-3 py-2 font-medium">Proposed inclusion</th>
                </tr>
              </thead>
              <tbody>
                {proposedPartChanges.map(({ part, label, fields }) => (
                  <tr key={`proposed-${part.draft_part_id}`} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="font-medium">{part.filename}</span>
                      <span className="block text-xs text-muted-foreground">{part.relative_path}</span>
                    </td>
                    <td className="px-3 py-2">
                      {label}{fields.length > 0 ? `: ${fields.join(", ")}` : ""}
                    </td>
                    <td className="px-3 py-2">{part.quantity_effective}</td>
                    <td className="px-3 py-2">{part.included ? "Included" : "Excluded"}</td>
                  </tr>
                ))}
                {draftWorkspace.diff.removed.map((part) => (
                  <tr key={`removed-${part.revision_part_id}`} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="font-medium">{part.filename}</span>
                      <span className="block text-xs text-muted-foreground">{part.relative_path}</span>
                    </td>
                    <td className="px-3 py-2">Removed</td>
                    <td className="px-3 py-2">Not applicable</td>
                    <td className="px-3 py-2">Removed</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!draftWorkspace.diff.base_is_current && (
          <p className="text-sm text-destructive" role="alert">
            The Accepted Plan changed after this Working Plan was saved. Refresh it before acceptance.
          </p>
        )}
        {draftWorkspace.reconciliation.kind === "unresolved" && (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
            <p className="text-sm">
              Resolve {draftWorkspace.reconciliation.conflicts.length} Required-unit conflict(s) before acceptance.
            </p>
            <div className="space-y-2">
              {draftWorkspace.reconciliation.conflicts.map((conflict) => {
                const key = `${conflict.kind}:${conflict.target_draft_part_id}`;
                const target = draftWorkspace.parts.find(
                  (part) => part.draft_part_id === conflict.target_draft_part_id,
                );
                return (
                  <label key={key} className="block space-y-1 text-sm">
                    <span className="block font-medium">
                      {target?.filename ?? `Working Plan Part ${conflict.target_draft_part_id}`}
                    </span>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={conflictChoices[key] ?? ""}
                      disabled={busy}
                      onChange={(event) => setConflictChoices((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))}
                    >
                      <option value="">Choose a resolution</option>
                      {conflict.kind === "ambiguous_exact_match" && conflict.candidate_revision_part_ids.map((candidateId) => (
                        <option key={candidateId} value={String(candidateId)}>
                          Reuse {acceptedRevisionPartLabels.get(candidateId) ?? `Accepted Plan Part ${candidateId}`}
                        </option>
                      ))}
                      {conflict.kind === "unsafe_predecessor" && (
                        <option value={String(conflict.predecessor_revision_part_id)}>
                          Keep prior completed units
                        </option>
                      )}
                      <option value="replace">Print as new units</option>
                    </select>
                  </label>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || draftWorkspace.reconciliation.conflicts.some((conflict) => (
                  !conflictChoices[`${conflict.kind}:${conflict.target_draft_part_id}`]
                ))}
                onClick={() => void onResolve()}
              >
                Save conflict decisions
              </Button>
            </div>
          </div>
        )}
        {productionBlock && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm text-destructive" role="alert">
              {productionBlock.checkoffLinkCount} Checkoff record(s)
              {productionBlock.sendQueueItemCount > 0
                ? ` and ${productionBlock.sendQueueItemCount} send-queue item(s)`
                : ""}{" "}
              are linked to the Accepted Plan. Acceptance is blocked to protect that progress.
            </p>
            <p className="text-sm text-muted-foreground">
              Remapping moves matching Checkoff records to the Working Plan during acceptance. Acceptance still fails if a printed file was removed or its printed count exceeds the new quantity.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              loading={busy}
              onClick={() => void onAccept({ remapCheckoffLinks: true })}
            >
              Remap and accept
            </Button>
          </div>
        )}
        <PlanDraftApplyButton
          workspace={draftWorkspace}
          busy={busy}
          onApply={() => void onAccept()}
          onRebase={() => void onRefresh()}
        />
      </CardContent>
    </Card>
  );
}

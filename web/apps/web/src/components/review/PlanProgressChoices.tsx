import { useState } from "react";
import type { PlanDraftWorkspace, RequiredUnitDecisionContract } from "@print-partner/contracts";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { planDraftRevisionPartLabels } from "../../lib/planDraftUi";
import { planSaveError } from "../../lib/planSaveError";
import { Button } from "../ui/button";

/** Only shown when changed files need a decision about existing print progress. */
export default function PlanProgressChoices({ workspace }: { workspace: PlanDraftWorkspace }) {
  const { reconcileActivePlanDraft, preparePlan } = usePlanWorkspace();
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conflicts = workspace.reconciliation.kind === "unresolved" ? workspace.reconciliation.conflicts : [];
  const labels = planDraftRevisionPartLabels(workspace);
  if (conflicts.length === 0) return null;

  async function save() {
    const decisions: RequiredUnitDecisionContract[] = [];
    for (const conflict of conflicts) {
      const choice = choices[conflict.target_draft_part_id];
      if (!choice) return;
      decisions.push(choice === "replace"
        ? { kind: "replace", target_draft_part_id: conflict.target_draft_part_id }
        : { kind: conflict.kind === "ambiguous_exact_match" ? "select_exact_predecessor" : "accept_prior_completion", target_draft_part_id: conflict.target_draft_part_id, predecessor_revision_part_id: Number(choice) });
    }
    setBusy(true);
    setError(null);
    try {
      await reconcileActivePlanDraft(decisions);
      await preparePlan();
    } catch (caught) {
      setError(planSaveError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="progress-choices-title" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 id="progress-choices-title" className="text-sm font-semibold">Keep previous print progress?</h2>
      <p className="text-sm text-muted-foreground">These files changed. Choose whether their previous prints still count.</p>
      {conflicts.map((conflict) => {
        const id = conflict.target_draft_part_id;
        const part = workspace.parts.find((item) => item.draft_part_id === id);
        return (
          <label key={id} className="grid gap-1 text-sm">
            <span>{part?.filename ?? "Changed file"}</span>
            <select className="h-11 rounded-md border border-input bg-background px-3" value={choices[id] ?? ""} disabled={busy} onChange={(event) => setChoices((current) => ({ ...current, [id]: event.target.value }))}>
              <option value="">Choose what happens</option>
              {conflict.kind === "ambiguous_exact_match" ? conflict.candidate_revision_part_ids.map((candidate) => (
                <option key={candidate} value={candidate}>Keep progress from {labels.get(candidate) ?? `part ${candidate}`}</option>
              )) : <option value={conflict.predecessor_revision_part_id}>Keep previous print progress</option>}
              <option value="replace">Print these units again</option>
            </select>
          </label>
        );
      })}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={busy || conflicts.some((conflict) => !choices[conflict.target_draft_part_id])} onClick={() => void save()}>{busy ? "Saving…" : "Save choices"}</Button>
    </section>
  );
}

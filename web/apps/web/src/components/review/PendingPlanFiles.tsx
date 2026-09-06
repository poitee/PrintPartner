import { useState, type FormEvent } from "react";
import type { PlanDraftPartDecisionContract, PlanDraftWorkspace } from "@print-partner/contracts";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export default function PendingPlanFiles({ workspace, disabled }: { workspace: PlanDraftWorkspace; disabled: boolean }) {
  const { editActivePlanDraft, preparePlan } = usePlanWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const decisions: PlanDraftPartDecisionContract[] = [];
    for (const part of workspace.parts) {
      const id = part.draft_part_id;
      const included = values.get(`include-${id}`) === "on";
      const quantity = Number(values.get(`quantity-${id}`));
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        setError("Enter a whole quantity of at least 1.");
        return;
      }
      if (included !== part.included) decisions.push({ kind: "set_included", draft_part_ids: [id], value: included });
      if (quantity !== part.quantity_effective) decisions.push({ kind: "set_quantity_override", draft_part_ids: [id], value: quantity });
    }
    setBusy(true);
    setError(null);
    try {
      if (decisions.length) await editActivePlanDraft(decisions);
      await preparePlan();
    } catch {
      setError("Not saved yet. Your choices are kept. Check the message above before retrying.");
    } finally {
      setBusy(false);
    }
  }
  return <form onSubmit={(event) => void save(event)} className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Pending Plan files">
    <h2 className="text-sm font-semibold">Pending files and quantities</h2>
    <p className="text-sm text-muted-foreground">These are your retained choices. If a file is no longer in the source, clear its checkbox to leave it out, or restore its source on Sources. Other choices and finished print progress are kept.</p>
    <fieldset disabled={disabled || busy} className="space-y-3">
      {workspace.parts.map((part) => <div key={part.draft_part_id} className="flex flex-wrap items-center gap-3 rounded border border-border p-3">
        <label className="flex min-w-0 flex-1 items-center gap-3 text-sm">
          <input type="checkbox" name={`include-${part.draft_part_id}`} defaultChecked={part.included} />
          <span className="break-all">{part.filename}<span className="block text-xs text-muted-foreground">{part.source_layer} / {part.relative_path}</span></span>
        </label>
        <Input className="w-24" type="number" min={1} step={1} required name={`quantity-${part.draft_part_id}`} aria-label={`Quantity for ${part.filename}`} defaultValue={part.quantity_effective} />
      </div>)}
      <Button type="submit">{busy ? "Saving…" : "Save pending choices"}</Button>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}

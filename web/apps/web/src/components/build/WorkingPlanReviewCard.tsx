import { useState } from "react";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { workingChangeFieldLabels } from "../../lib/planAcceptanceModel";
import { usePlanAcceptance } from "../review/PlanAcceptanceContext";
import { Button } from "../ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

type ChangeRow = {
  readonly key: string;
  readonly filename: string;
  readonly path: string;
  readonly change: string;
  readonly quantity: string;
  readonly inclusion: string;
};

/**
 * Step 2 of the Plan checkpoint: what the Working Plan would change.
 *
 * "Working Plan changes" replaces the old "Saved Plan draft" wording. The user
 * is comparing two revisions of their own Build, not managing a draft record.
 */
export default function WorkingPlanReviewCard() {
  const { model, busy, prepareWorkingPlan } = usePlanAcceptance();
  const { draftWorkspace } = usePlanWorkspace();
  const working = model.working;
  const [expanded, setExpanded] = useState(false);

  if (!working) {
    return (
      <section
        id="plan-working-changes"
        aria-labelledby="plan-working-changes-heading"
        className="rounded-lg border border-border bg-card p-4 shadow-sm"
      >
        <h2 id="plan-working-changes-heading" className="text-sm font-semibold">
          Create a Working Plan
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Build one from the current Sources to review parts and quantities before publishing.
        </p>
        <Button
          type="button"
          variant="secondary"
          className="mt-3 min-h-11"
          disabled={busy}
          loading={busy}
          onClick={prepareWorkingPlan}
        >
          Build Working Plan from Sources
        </Button>
      </section>
    );
  }

  const rows: ChangeRow[] = draftWorkspace
    ? [
        ...draftWorkspace.diff.added.map((part) => ({
          key: `added-${part.draft_part_id}`,
          filename: part.filename,
          path: part.relative_path,
          change: "Added",
          quantity: String(part.quantity_effective),
          inclusion: part.included ? "Included" : "Excluded",
        })),
        ...draftWorkspace.diff.changed.map((change) => ({
          key: `changed-${change.after.draft_part_id}`,
          filename: change.after.filename,
          path: change.after.relative_path,
          change:
            change.fields.length > 0
              ? `Changed ${workingChangeFieldLabels(change.fields).join(", ")}`
              : "Changed",
          quantity: String(change.after.quantity_effective),
          inclusion: change.after.included ? "Included" : "Excluded",
        })),
        ...draftWorkspace.diff.removed.map((part) => ({
          key: `removed-${part.revision_part_id}`,
          filename: part.filename,
          path: part.relative_path,
          change: "Removed",
          quantity: "Not applicable",
          inclusion: "Removed",
        })),
      ]
    : [];

  return (
    <section
      id="plan-working-changes"
      aria-labelledby="plan-working-changes-heading"
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <h2 id="plan-working-changes-heading" className="text-sm font-semibold">
        Working Plan changes
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {model.accepted.planVersion == null
          ? "Publishing this Working Plan creates the fixed part list Production and Checkoff will use."
          : "Not published yet. Production and Checkoff keep using the published revision until you publish this one."}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Added", value: working.added },
          { label: "Changed", value: working.changed },
          { label: "Removed", value: working.removed },
          { label: "Unaffected", value: working.unaffected },
        ].map((cell) => (
          <div key={cell.label}>
            <dt className="text-xs text-muted-foreground">{cell.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{cell.value}</dd>
          </div>
        ))}
      </dl>

      {rows.length > 0 && (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3 min-h-11 print:hidden"
            aria-expanded={expanded}
            aria-controls="working-plan-change-details"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Hide part changes" : `Show ${rows.length} part changes`}
          </Button>
          <div
            id="working-plan-change-details"
            className={expanded ? "mt-3" : "mt-3 hidden print:block"}
          >
            <ul className="space-y-2 md:hidden print:hidden">
              {rows.map((row) => (
                <li key={row.key} className="rounded-md border border-border p-3 text-sm">
                  <p className="font-medium">{row.filename}</p>
                  <p className="text-xs text-muted-foreground">{row.path}</p>
                  <p className="mt-1">{row.change}</p>
                  <p className="text-xs text-muted-foreground">
                    Working quantity {row.quantity} · {row.inclusion}
                  </p>
                </li>
              ))}
            </ul>
            <div className="hidden rounded-md border border-border md:block print:block">
              <Table className="text-left">
                <caption className="sr-only">Parts changed by the Working Plan</caption>
                <TableHeader className="bg-surface-sunken">
                  <TableRow>
                    <TableHead scope="col">Part</TableHead>
                    <TableHead scope="col">Change</TableHead>
                    <TableHead scope="col">Working quantity</TableHead>
                    <TableHead scope="col">Working inclusion</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell>
                        <span className="font-medium">{row.filename}</span>
                        <span className="block text-xs text-muted-foreground">{row.path}</span>
                      </TableCell>
                      <TableCell>{row.change}</TableCell>
                      <TableCell className="tabular-nums">{row.quantity}</TableCell>
                      <TableCell>{row.inclusion}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

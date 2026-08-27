import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { workingChangeFieldLabels } from "../../lib/planAcceptanceModel";
import { usePlanAcceptance } from "../review/PlanAcceptanceContext";

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
  const { model } = usePlanAcceptance();
  const { draftWorkspace } = usePlanWorkspace();
  const working = model.working;

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
      {working ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Not accepted yet. Production and Checkoff keep using the Accepted revision until you
          accept.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          No working changes. Production and Checkoff are using the Accepted revision.
        </p>
      )}

      {working && (
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
      )}

      {rows.length > 0 && (
        <>
          <ul className="mt-3 space-y-2 md:hidden">
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
          <div className="mt-3 hidden overflow-x-auto rounded-md border border-border md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Parts changed by the Working Plan</caption>
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Part</th>
                  <th scope="col" className="px-3 py-2 font-medium">Change</th>
                  <th scope="col" className="px-3 py-2 font-medium">Working quantity</th>
                  <th scope="col" className="px-3 py-2 font-medium">Working inclusion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="font-medium">{row.filename}</span>
                      <span className="block text-xs text-muted-foreground">{row.path}</span>
                    </td>
                    <td className="px-3 py-2">{row.change}</td>
                    <td className="px-3 py-2 tabular-nums">{row.quantity}</td>
                    <td className="px-3 py-2">{row.inclusion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

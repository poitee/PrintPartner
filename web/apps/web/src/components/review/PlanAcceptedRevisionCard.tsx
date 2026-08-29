import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import { usePlanAcceptance } from "./PlanAcceptanceContext";

/**
 * Step 1 of the Plan checkpoint: what is published right now. Everything below
 * is measured against this, so it comes first and states plain totals.
 */
export default function PlanAcceptedRevisionCard() {
  const { model } = usePlanAcceptance();
  const { review } = usePlanWorkspace();
  const accepted = model.accepted;
  const layers = review?.layers ?? [];

  return (
    <section
      id="plan-accepted-revision"
      aria-labelledby="plan-accepted-revision-heading"
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <h2 id="plan-accepted-revision-heading" className="text-sm font-semibold">
        Published revision
      </h2>
      <p className="mt-1 text-base font-medium text-foreground">{accepted.heading}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {accepted.planVersion == null
          ? "Publish a Working Plan before Production and Checkoff can start."
          : model.working
            ? "Production and Checkoff still use this revision until you publish the working changes below."
            : "Production and Checkoff use this revision."}
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Required units</dt>
          <dd className="text-lg font-semibold tabular-nums">{accepted.requiredUnits}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Verified units</dt>
          <dd className="text-lg font-semibold tabular-nums">{accepted.verifiedUnits}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Remaining units</dt>
          <dd className="text-lg font-semibold tabular-nums">{accepted.remainingUnits}</dd>
        </div>
      </dl>
      {layers.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Built from{" "}
          {layers
            .map((layer) => `${layer.project_name ?? "Unnamed source"} (${layer.synced ? "synced" : "not synced"})`)
            .join(", ")}
        </p>
      )}
    </section>
  );
}

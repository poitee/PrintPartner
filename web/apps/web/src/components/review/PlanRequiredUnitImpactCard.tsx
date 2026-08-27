import { usePlanAcceptance } from "./PlanAcceptanceContext";

/**
 * Step 5 of the Plan checkpoint: what acceptance does to printed work.
 *
 * This is the answer to "will I lose what I already printed?", so it uses unit
 * counts and plain verbs instead of revision mapping terms.
 */
export default function PlanRequiredUnitImpactCard() {
  const { model } = usePlanAcceptance();
  const impact = model.impact;

  return (
    <section
      id="plan-required-unit-impact"
      aria-labelledby="plan-required-unit-impact-heading"
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <h2 id="plan-required-unit-impact-heading" className="text-sm font-semibold">
        Required-unit impact
      </h2>
      {impact.kind === "unavailable" ? (
        <p className="mt-1 text-sm text-muted-foreground">{impact.reason}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            After acceptance this Build requires {impact.requiredUnitsAfter} units. Kept units keep
            their printed and verified state.
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Units kept</dt>
              <dd className="text-lg font-semibold tabular-nums">{impact.preservedUnits}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Must be printed again</dt>
              <dd className="text-lg font-semibold tabular-nums">{impact.printAgainUnits}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">No longer required</dt>
              <dd className="text-lg font-semibold tabular-nums">{impact.retiredUnits}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}

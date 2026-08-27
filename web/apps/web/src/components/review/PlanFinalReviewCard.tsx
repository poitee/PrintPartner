import { usePlanAcceptance } from "./PlanAcceptanceContext";

type SummaryRow = {
  readonly label: string;
  readonly value: string;
  readonly reviewHref: string;
};

/**
 * Step 6 of the Plan checkpoint: the check-answers list.
 *
 * One place that repeats every decision above, each row linking back to the
 * section that can change it, so the user reads the whole revision before the
 * single action underneath.
 */
export default function PlanFinalReviewCard() {
  const { model } = usePlanAcceptance();
  const working = model.working;
  const impact = model.impact;

  const rows: SummaryRow[] = [
    {
      label: "Accepted revision",
      value: model.accepted.heading,
      reviewHref: "#plan-accepted-revision",
    },
    {
      label: "Working changes",
      value: working
        ? `${working.added} added, ${working.changed} changed, ${working.removed} removed, ${working.unaffected} unaffected`
        : "None",
      reviewHref: "#plan-working-changes",
    },
    {
      label: "Must resolve",
      value:
        model.mustResolve.length === 0
          ? "Nothing outstanding"
          : `${model.mustResolve.length} outstanding`,
      reviewHref: "#plan-issues",
    },
    {
      label: "Review recommended",
      value:
        model.reviewRecommended.length === 0
          ? "Nothing to check"
          : `${model.reviewRecommended.length} to check`,
      reviewHref: "#plan-issues",
    },
    {
      label: "Required units after acceptance",
      value:
        impact.kind === "ready"
          ? `${impact.requiredUnitsAfter} units, ${impact.preservedUnits} kept from the Accepted revision`
          : working
            ? "Not known until the decisions above are answered"
            : `${model.accepted.requiredUnits} units, unchanged`,
      reviewHref: "#plan-required-unit-impact",
    },
  ];

  return (
    <section
      id="plan-final-review"
      aria-labelledby="plan-final-review-heading"
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <h2 id="plan-final-review-heading" className="text-sm font-semibold">
        Final review
      </h2>
      <dl className="mt-2 divide-y divide-border text-sm">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          >
            <dt className="text-muted-foreground sm:w-64 sm:shrink-0">{row.label}</dt>
            <dd className="flex-1 font-medium text-foreground">{row.value}</dd>
            <a
              className="text-xs text-primary underline underline-offset-2 sm:shrink-0"
              href={row.reviewHref}
            >
              Review<span className="sr-only"> {row.label}</span>
            </a>
          </div>
        ))}
      </dl>
    </section>
  );
}

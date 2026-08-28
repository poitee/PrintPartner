import { Fragment, useEffect, useRef, useState } from "react";
import type { ProductionRoute } from "@print-partner/contracts";
import {
  PRODUCTION_ROUTE_DESCRIPTION,
  PRODUCTION_ROUTE_LABEL,
  PRODUCTION_ROUTE_ORDER,
} from "../../lib/workPackageTasks";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = Readonly<{
  /**
   * The route already saved. Null on the first answer. On a change the previous
   * answer comes back pre-selected, the way GOV.UK's check answers pattern
   * requires of a Change link.
   */
  value: ProductionRoute | null;
  /** The answer the operator settled on. */
  onSubmit: (route: ProductionRoute) => void;
  /** Offered only when there is an answer to go back to. */
  onCancel?: () => void;
  saving: boolean;
  /** A failed save. The answer stays on screen and Retry reruns it in place. */
  error: Readonly<{ message: string; onRetry: () => void }> | null;
}>;

const ERROR_ID = "production-route-error";
const LEGEND_ID = "production-route-legend";

/**
 * The one question Production asks before it shows any task list.
 *
 * A branch belongs above the list, not inside it: USWDS says to consider
 * another approach when the number of steps can change from user input, and the
 * three routes have three different lengths. So this is a radio question in a
 * fieldset, in the USWDS tile treatment that gives each route a description line
 * and a shop-floor target, and it never conditionally reveals a task list.
 *
 * No option is pre-selected on a first answer. GOV.UK is flat about this:
 * pre-selecting makes people more likely to miss the question or submit the
 * wrong answer. The 44 by 44 targets are deliberately WCAG 2.2 SC 2.5.5 (AAA)
 * rather than the 24 by 24 AA line, because SC 2.5.5's intent asks for larger
 * targets on frequent controls whose result is hard to undo.
 */
export default function ProductionRouteQuestion({
  value,
  onSubmit,
  onCancel,
  saving,
  error,
}: Props) {
  const [chosen, setChosen] = useState<ProductionRoute | null>(value);
  const [missing, setMissing] = useState(false);
  const missingRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (missing) missingRef.current?.focus();
  }, [missing]);

  return (
    <div className="space-y-3">
      <fieldset
        className="space-y-3"
        aria-describedby={missing ? ERROR_ID : undefined}
        aria-invalid={missing || undefined}
      >
        <legend id={LEGEND_ID} className="text-sm font-semibold text-foreground">
          How do you want to make these units?
        </legend>

        {missing ? (
          <p
            id={ERROR_ID}
            ref={missingRef}
            tabIndex={-1}
            className="rounded-md border border-destructive/35 bg-destructive-soft px-3 py-2 text-sm font-medium text-destructive"
          >
            {/* GOV.UK prefixes error messages with a visually hidden "Error:"
                so a screen reader hears that the line is a problem. */}
            <span className="sr-only">Error:</span>{" "}
            <span>Select how you want to make these units</span>
          </p>
        ) : null}

        {/* One column at every width. A phone gets the same reading order as a
            workshop monitor, which is what SC 1.4.10 Reflow asks for. */}
        <div className="grid gap-2">
          {PRODUCTION_ROUTE_ORDER.map((route) => (
            <Fragment key={route}>
              {/* GOV.UK: separate an option phrased differently from the others
                  with an "or" divider. Recording a print is a record of work
                  already done, not work PrintPartner will do. */}
              {route === "external" ? (
                <p className="py-1 text-center text-sm text-muted-foreground">or</p>
              ) : null}
              <label
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                  chosen === route
                    ? "border-primary bg-accent/60 ring-2 ring-primary/60"
                    : "border-border-strong bg-card hover:bg-accent/40",
                )}
              >
                <input
                  type="radio"
                  name="production-route"
                  value={route}
                  checked={chosen === route}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                  aria-describedby={`production-route-${route}-hint`}
                  onChange={() => {
                    setChosen(route);
                    setMissing(false);
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">
                    {PRODUCTION_ROUTE_LABEL[route]}
                  </span>
                  <span
                    id={`production-route-${route}-hint`}
                    className="mt-0.5 block text-xs text-muted-foreground"
                  >
                    {PRODUCTION_ROUTE_DESCRIPTION[route]}
                  </span>
                </span>
              </label>
            </Fragment>
          ))}
        </div>
      </fieldset>

      {error ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/35 bg-destructive-soft px-3 py-2"
          role="alert"
        >
          <p className="min-w-0 flex-1 text-sm text-destructive">{error.message}</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-9 shrink-0"
            onClick={error.onRetry}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="shop"
          loading={saving}
          onClick={() => {
            if (chosen == null) {
              setMissing(true);
              return;
            }
            onSubmit(chosen);
          }}
        >
          Continue
        </Button>
        {onCancel ? (
          <Button type="button" size="shop" variant="ghost" onClick={onCancel}>
            Keep this route
          </Button>
        ) : null}
      </div>
    </div>
  );
}

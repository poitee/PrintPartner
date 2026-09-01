import { useEffect, useRef, useState } from "react";
import type { ProductionRoute } from "@print-partner/contracts";
import {
  PRODUCTION_ROUTE_DESCRIPTION,
  PRODUCTION_ROUTE_LABEL,
} from "../../lib/workPackageTasks";
import { Alert, AlertActions, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { statusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

type PreparationRoute = Exclude<ProductionRoute, "external">;

type Props = Readonly<{
  /**
   * The route already saved. Null on the first answer. On a change the previous
   * answer comes back pre-selected, the way GOV.UK's check answers pattern
   * requires of a Change link.
   */
  value: PreparationRoute | null;
  /** The answer the operator settled on. */
  onSubmit: (route: PreparationRoute) => void;
  /** Offered only when there is an answer to go back to. */
  onCancel?: () => void;
  saving: boolean;
  /** A failed save. The answer stays on screen and Retry reruns it in place. */
  error: Readonly<{ message: string; onRetry: () => void }> | null;
}>;

const ERROR_ID = "production-route-error";
const LEGEND_ID = "production-route-legend";
const PREPARATION_ROUTE_ORDER = ["plates", "stl"] as const satisfies readonly PreparationRoute[];

/**
 * The one question Production asks before it shows any task list.
 *
 * A branch belongs above the list, not inside it: USWDS says to consider
 * another approach when the number of steps can change from user input, and the
 * the two preparation routes have different lengths. So this is a radio question in a
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
  const [chosen, setChosen] = useState<PreparationRoute | null>(value);
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
          What should PrintPartner prepare?
        </legend>

        {missing ? (
          <p
            id={ERROR_ID}
            ref={missingRef}
            tabIndex={-1}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium",
              statusTone({ tone: "error", emphasis: "soft" }),
            )}
          >
            {/* GOV.UK prefixes error messages with a visually hidden "Error:"
                so a screen reader hears that the line is a problem. */}
            <span className="sr-only">Error:</span>{" "}
            <span>Select what PrintPartner should prepare</span>
          </p>
        ) : null}

        {/* One column at every width. A phone gets the same reading order as a
            workshop monitor, which is what SC 1.4.10 Reflow asks for. */}
        <RadioGroup
          className="grid gap-2"
          // The legend names the fieldset; the radio group is a separate node in
          // the accessibility tree, so it has to be told the same name.
          aria-labelledby={LEGEND_ID}
          aria-describedby={missing ? ERROR_ID : undefined}
          aria-invalid={missing || undefined}
          value={chosen ?? ""}
          onValueChange={(next) => {
            setChosen(next as PreparationRoute);
            setMissing(false);
          }}
        >
          {PREPARATION_ROUTE_ORDER.map((route) => (
            <label
              key={route}
              // A wrapping label does not name a `role="radio"` button, so the
              // name comes from `for`, which does.
              htmlFor={`production-route-${route}`}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                chosen === route
                  ? "border-primary bg-accent/60 ring-2 ring-primary/60"
                  : "border-border-strong bg-card hover:bg-accent/40",
              )}
            >
              <RadioGroupItem
                id={`production-route-${route}`}
                size="shop"
                value={route}
                className="mt-0.5"
                aria-describedby={`production-route-${route}-hint`}
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
          ))}
        </RadioGroup>
      </fieldset>

      {error ? (
        <Alert tone="error">
          <AlertDescription className="min-w-0">{error.message}</AlertDescription>
          <AlertActions>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="min-h-9 shrink-0"
              onClick={error.onRetry}
            >
              Retry
            </Button>
          </AlertActions>
        </Alert>
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

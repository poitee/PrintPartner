import type { ProductionRouteChange } from "../../lib/workPackageProjection";
import { PRODUCTION_ROUTE_LABEL } from "../../lib/workPackageTasks";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

type Props = Readonly<{
  /** Null when no switch is waiting for an answer. */
  change: ProductionRouteChange | null;
  saving: boolean;
  /** A failed save. Persistent and inline, never a toast. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}>;

const BODY_ID = "production-route-change-effect";

/**
 * Names what a route switch does to work already done, then waits for an
 * explicit action.
 *
 * WCAG 2.2 SC 3.3.4 Error Prevention accepts reversible, checked, or confirmed.
 * This switch is reversible: `productionRouteChange` explains why nothing is
 * deleted. The dialog adds confirmed on top, because Plate work represents real
 * time at a workshop bench and an operator who taps the wrong tile deserves to
 * see what they are stepping away from before it happens.
 *
 * Saying "nothing is deleted" out loud is the point. Nielsen's third heuristic
 * is about the confidence to explore, and a warning that leaves the operator
 * guessing whether their Plates survived is the same failure as a warning that
 * hides a discard.
 */
export default function ProductionRouteChangeDialog({
  change,
  saving,
  error,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog
      open={change != null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={BODY_ID}>
        <DialogHeader>
          <DialogTitle>
            {change
              ? `Change route from "${PRODUCTION_ROUTE_LABEL[change.from]}" to "${PRODUCTION_ROUTE_LABEL[change.to]}"?`
              : "Change route?"}
          </DialogTitle>
        </DialogHeader>

        <div id={BODY_ID} className="space-y-3 text-sm">
          {change && change.setAside.length > 0 ? (
            <div className="space-y-1">
              <p className="font-semibold text-foreground">This work package will stop using:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {change.setAside.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                Nothing is deleted. Change back to &ldquo;{PRODUCTION_ROUTE_LABEL[change.from]}
                &rdquo; and this work is still here.
              </p>
            </div>
          ) : null}

          {change && change.kept.length > 0 ? (
            <div className="space-y-1">
              <p className="font-semibold text-foreground">It will keep:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {change.kept.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-muted-foreground">
            Verified units in Checkoff are not affected.
          </p>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
          <Button type="button" size="shop" loading={saving} onClick={onConfirm}>
            {change ? `Change to "${PRODUCTION_ROUTE_LABEL[change.to]}"` : "Change route"}
          </Button>
          <Button type="button" variant="ghost" size="shop" disabled={saving} onClick={onCancel}>
            Keep this route
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

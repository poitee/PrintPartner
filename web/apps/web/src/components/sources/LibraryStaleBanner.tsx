import { TriangleAlert } from "lucide-react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

type Props = {
  staleCount: number;
  attachedStaleCount?: number;
  onSeeChanges: () => void;
  className?: string;
};

/** Banner when upstream GitHub sources have moved since last sync. */
export default function LibraryStaleBanner({
  staleCount,
  attachedStaleCount = 0,
  onSeeChanges,
  className,
}: Props) {
  if (staleCount <= 0) return null;

  const detail =
    attachedStaleCount > 0
      ? `${attachedStaleCount} of them ${attachedStaleCount === 1 ? "is" : "are"} in your plan.`
      : "Your plan may still use older files.";

  return (
    <Alert tone="warning" className={className}>
      <TriangleAlert aria-hidden />
      <AlertTitle>
        {staleCount} source{staleCount === 1 ? "" : "s"} moved upstream.
      </AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
      <AlertActions>
        <Button size="sm" variant="outline" onClick={onSeeChanges}>
          See what changed
        </Button>
      </AlertActions>
    </Alert>
  );
}

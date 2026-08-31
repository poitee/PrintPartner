import { statusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Spinner } from "../ui/spinner";

export type CheckoffResourceState = "loading" | "ready" | "error" | "empty" | "offline";

type Props = {
  engineState: CheckoffResourceState;
  profilesState: CheckoffResourceState;
  reviewState: CheckoffResourceState;
  profilesError: string | null;
  workspaceError: string | null;
  onReloadProfiles: () => void;
  onRetryReview: () => void;
  /** Shown when everything loaded but there is no work to show. */
  emptyState: React.ReactNode;
};

/**
 * The console before it has data: engine reachable, Builds loaded, Checkoff
 * read. Each state names what is happening and who can move it forward.
 */
export default function CheckoffStateNotice({
  engineState,
  profilesState,
  reviewState,
  profilesError,
  workspaceError,
  onReloadProfiles,
  onRetryReview,
  emptyState,
}: Props) {
  if (engineState !== "ready") {
    return (
      <Card className="no-print">
        <CardContent className="pt-6">
          <p
            className="text-sm text-muted-foreground"
            role={engineState === "loading" ? "status" : undefined}
            aria-live={engineState === "loading" ? "polite" : undefined}
            aria-atomic={engineState === "loading" ? "true" : undefined}
          >
            {engineState === "offline"
              ? "Engine offline. Start the print-partner engine to use Checkoff."
              : "Connecting to the engine…"}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (profilesState === "error") {
    return (
      <Card
        className={cn(
          "no-print shadow-none",
          statusTone({ tone: "error", emphasis: "surface" }),
        )}
      >
        <CardContent className="space-y-3 pt-6">
          <p className="text-sm text-destructive" role="alert">
            Could not load plans: {profilesError}
          </p>
          <Button size="sm" variant="secondary" onClick={onReloadProfiles}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (profilesState === "loading" || reviewState === "loading") {
    return (
      <Card className="no-print border-border shadow-sm">
        <CardContent
          className="flex items-center gap-2 pt-6"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Spinner className="size-4" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Loading progress…</p>
        </CardContent>
      </Card>
    );
  }

  if (reviewState === "error") {
    return (
      <Card
        className={cn(
          "no-print shadow-none",
          statusTone({ tone: "error", emphasis: "surface" }),
        )}
      >
        <CardContent className="space-y-3 pt-6">
          <p className="text-sm text-destructive" role="alert">
            Could not load Checkoff: {workspaceError}
          </p>
          <Button size="sm" variant="secondary" onClick={onRetryReview}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <div className="no-print">{emptyState}</div>;
}

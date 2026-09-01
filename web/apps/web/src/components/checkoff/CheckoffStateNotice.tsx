import { Alert, AlertActions, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
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
 *
 * Only the two waiting states are live regions, and only they announce. An
 * offline engine is a standing condition the operator reads, not an
 * interruption, so it keeps the plain banner it always had.
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
    const connecting = engineState === "loading";
    return (
      <Alert
        tone={connecting ? "neutral" : "warning"}
        className="no-print"
        role={connecting ? "status" : undefined}
        aria-live={connecting ? "polite" : undefined}
        aria-atomic={connecting ? "true" : undefined}
      >
        {connecting ? <Spinner className="size-4" aria-hidden="true" /> : null}
        <AlertTitle className="font-normal">
          {engineState === "offline"
            ? "Engine offline. Start the print-partner engine to use Checkoff."
            : "Connecting to the engine…"}
        </AlertTitle>
      </Alert>
    );
  }

  if (profilesState === "error") {
    return (
      <Alert tone="error" className="no-print">
        <AlertTitle className="font-normal">Could not load plans: {profilesError}</AlertTitle>
        <AlertActions>
          <Button size="sm" variant="secondary" onClick={onReloadProfiles}>
            Retry
          </Button>
        </AlertActions>
      </Alert>
    );
  }

  if (profilesState === "loading" || reviewState === "loading") {
    return (
      <Alert
        tone="neutral"
        className="no-print"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Spinner className="size-4" aria-hidden="true" />
        <AlertTitle className="font-normal">Loading progress…</AlertTitle>
      </Alert>
    );
  }

  if (reviewState === "error") {
    return (
      <Alert tone="error" className="no-print">
        <AlertTitle className="font-normal">Could not load Checkoff: {workspaceError}</AlertTitle>
        <AlertActions>
          <Button size="sm" variant="secondary" onClick={onRetryReview}>
            Retry
          </Button>
        </AlertActions>
      </Alert>
    );
  }

  return <div className="no-print">{emptyState}</div>;
}

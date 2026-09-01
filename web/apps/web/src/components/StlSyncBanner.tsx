import { Spinner } from "./ui/spinner";
import { Alert, AlertActions, AlertTitle } from "./ui/alert";
import { cn } from "@/lib/utils";
import type { StlSyncBannerMode } from "../lib/stlAutoSync";

type Props = {
  mode: StlSyncBannerMode;
  onSync: () => void;
  syncDisabled?: boolean;
  className?: string;
};

/**
 * GRE-235 Parts banner — one line for running / still-missing / failed.
 * Hide Sync while running; Sync is retry after fail or when files still gone.
 */
export default function StlSyncBanner({
  mode,
  onSync,
  syncDisabled,
  className,
}: Props) {
  if (mode.kind === "hidden") return null;

  if (mode.kind === "running") {
    return (
      <Alert
        tone="neutral"
        role="status"
        aria-live="polite"
        className={cn("items-center", className)}
      >
        <Spinner className="size-4 shrink-0" />
        <AlertTitle>Syncing STLs…</AlertTitle>
      </Alert>
    );
  }

  const label =
    mode.kind === "failed" ? "Sync failed" : `${mode.count} STL missing`;

  return (
    <Alert tone="warning" className={cn("items-center", className)}>
      <AlertTitle>{label}</AlertTitle>
      <AlertActions>
        <button
          type="button"
          className="text-xs font-medium text-primary underline disabled:opacity-50"
          onClick={onSync}
          disabled={syncDisabled}
        >
          Sync
        </button>
      </AlertActions>
    </Alert>
  );
}

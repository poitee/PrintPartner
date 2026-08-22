import { Spinner } from "./ui/spinner";
import { cn } from "../lib/utils";
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
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm",
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <Spinner className="size-4 shrink-0" />
        <span className="font-medium">Syncing STLs…</span>
      </div>
    );
  }

  const label =
    mode.kind === "failed" ? "Sync failed" : `${mode.count} STL missing`;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border border-warning bg-warning/15 px-3 py-2.5 text-sm",
        className,
      )}
      role="alert"
    >
      <span className="font-medium">{label}</span>
      <button
        type="button"
        className="text-xs font-medium text-primary underline disabled:opacity-50"
        onClick={onSync}
        disabled={syncDisabled}
      >
        Sync
      </button>
    </div>
  );
}

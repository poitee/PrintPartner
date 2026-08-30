import { useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { useJobContext } from "../context/JobContext";
import { jobKindLabel } from "../lib/jobLabels";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

const STATUS_STYLES: Record<string, string> = {
  pending: "text-warning",
  running: "text-info",
  done: "text-success",
  error: "text-destructive",
  cancelled: "text-muted-foreground",
};

type Props = {
  /** When true, rail is icon-width; keeps tray aligned with main column. */
  sidebarCollapsed?: boolean;
};

/**
 * Async job status strip. Sits above the mobile navigation row.
 *
 * The strip is fixed, so it publishes its measured height as
 * `--job-tray-height`. The main scroll area reserves that space instead of
 * letting a running job cover the bottom of the page.
 *
 * The footer stays mounted while empty so the live region exists before its
 * first message. A live region that mounts together with its content is not
 * reliably announced.
 */
export default function JobTray({ sidebarCollapsed = false }: Props) {
  const { activeJobs, clearJob } = useJobContext();
  const trayRef = useRef<HTMLElement | null>(null);
  const hasJobs = activeJobs.length > 0;

  useEffect(() => {
    const root = document.documentElement;
    const node = trayRef.current;
    if (!node || !hasJobs) {
      root.style.setProperty("--job-tray-height", "0px");
      return;
    }
    const publish = () => {
      root.style.setProperty("--job-tray-height", `${node.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.setProperty("--job-tray-height", "0px");
    };
  }, [hasJobs]);

  return (
    <footer
      ref={trayRef}
      className={cn(
        "job-tray fixed left-0 right-0 z-50 border-t border-border bg-card/95 backdrop-blur-sm",
        "bottom-[var(--mobile-stage-height,0px)]",
        "lg:left-[var(--app-sidebar-width,18rem)]",
        sidebarCollapsed && "lg:left-[4.25rem]",
        !hasJobs && "hidden",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="divide-y divide-border">
        {activeJobs.map((job) => {
          const pct =
            job.progress != null
              ? Math.round(Math.min(100, Math.max(0, job.progress * 100)))
              : null;
          const isActive = job.status === "pending" || job.status === "running";
          const statusClass = STATUS_STYLES[job.status] ?? "text-muted-foreground";
          const canDismiss = !isActive;

          return (
            <div
              key={job.jobId || job.kind}
              className="relative flex items-center gap-3 px-5 py-2.5 text-sm"
            >
              {isActive ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
              ) : null}
              <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {jobKindLabel(job.kind)}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">{job.message}</span>
              {pct != null ? (
                <span className="shrink-0 tabular-nums text-xs text-primary">{pct}%</span>
              ) : null}
              <span className={cn("shrink-0 text-xs capitalize", statusClass)}>
                {job.status}
              </span>
              {canDismiss && job.jobId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label="Dismiss"
                  onClick={() => clearJob(job.jobId)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              {pct != null && isActive ? (
                <div
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary/20"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full bg-primary transition-[width] duration-200 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </footer>
  );
}

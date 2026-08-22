import { Loader2 } from "lucide-react";
import type { AcceptedPlateExportRecord } from "@print-partner/contracts";
import { useJobContext, type ActiveJob } from "../../context/JobContext";
import { useProfileSelection } from "../../context/ProfileContext";
import {
  useAcceptedPlateExportJobsQuery,
  useAcceptedPlateWorkspaceQuery,
} from "../../queries/acceptedPlates";

export const EXPORT_JOB_KINDS = new Set([
  "stl-export",
  "export",
  "export-accepted-plate-3mf",
  "kit-export",
  "export-checklist-html",
  "export-kit-bundle",
  "printer-upload",
]);

export function hasExportJobs(jobs: readonly Pick<ActiveJob, "kind">[]): boolean {
  return jobs.some((job) => EXPORT_JOB_KINDS.has(job.kind));
}

export function acceptedPlateRecentJobs(
  activeJobs: readonly ActiveJob[],
  history: readonly AcceptedPlateExportRecord[],
  profileId: number | null,
) {
  const scopedContext = activeJobs.filter((job) =>
    job.kind === "export-accepted-plate-3mf" && job.profileId === profileId);
  const runningContext = scopedContext.filter((job) => job.status === "pending" || job.status === "running");
  const failedContext = scopedContext.filter((job) => job.status === "error" || job.status === "cancelled");
  const contextIds = new Set([...runningContext, ...failedContext].map((job) => job.jobId));
  const deduplicatedHistory = history.filter((job) => !contextIds.has(job.job_id));
  return {
    runningContext,
    failedContext,
    runningHistory: deduplicatedHistory.filter((job) => job.status === "pending" || job.status === "running"),
    completed: deduplicatedHistory.filter((job) => job.status !== "pending" && job.status !== "running"),
  };
}

export function acceptedPlateRevisionLabel(
  revision: number,
  displayedRevision: number | null,
): string {
  if (displayedRevision == null) return `Plate revision ${revision}`;
  return displayedRevision === revision
    ? `Current Plate revision ${revision}`
    : `Plate revision ${revision}`;
}

export default function ExportRecentPanel() {
  const { selectedProfileId } = useProfileSelection();
  const { activeJobs } = useJobContext();
  const history = useAcceptedPlateExportJobsQuery(selectedProfileId, selectedProfileId != null);
  const workspace = useAcceptedPlateWorkspaceQuery(selectedProfileId, selectedProfileId != null);
  const displayedRevision = workspace.data?.kind === "ready"
    ? workspace.data.plate_revision_number
    : null;
  const { runningContext, failedContext, runningHistory, completed } = acceptedPlateRecentJobs(
    activeJobs,
    history.data ?? [],
    selectedProfileId,
  );

  const hasRows = runningContext.length > 0 || failedContext.length > 0 || runningHistory.length > 0 || completed.length > 0;
  if (!hasRows && !history.isPending && !history.isError) return null;

  return (
    <aside className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3.5 shadow-sm">
      <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Recent accepted Plate exports
      </span>
      {history.isError ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">Could not refresh recent exports.</p>
      ) : null}
      <ul className="flex flex-col gap-0">
        {[...runningContext].reverse().map((job) => (
          <li key={job.jobId} className="border-b border-border/60 py-2.5 first:pt-0">
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" />
              <span className="text-xs">{job.message || "Exporting accepted Plates…"}</span>
            </div>
          </li>
        ))}
        {runningHistory.map((job) => (
          <li key={job.job_id} className="border-b border-border/60 py-2.5 first:pt-0">
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" />
              <span className="text-xs">{job.message || "Exporting accepted Plates…"}</span>
            </div>
          </li>
        ))}
        {[...failedContext].reverse().map((job) => (
          <li key={job.jobId} className="border-b border-border/60 py-2.5 first:pt-0">
            <span className="text-xs text-destructive">{job.message || "Accepted Plate export failed."}</span>
          </li>
        ))}
        {completed.map((job) => {
          const result = job.result;
          const revisionLabel = result == null
            ? null
            : acceptedPlateRevisionLabel(result.plate_revision_number, displayedRevision);
          return (
            <li key={job.job_id} className="flex flex-col gap-1 border-b border-border/60 py-2.5 last:border-b-0 last:pb-0 first:pt-0">
              <span className="text-[12.5px] font-semibold">Accepted Plate 3MF</span>
              {revisionLabel ? <span className="text-xs text-muted-foreground">{revisionLabel}</span> : null}
              {result ? (
                <a className="text-xs font-medium text-primary underline" href={result.download_url} download>
                  Download 3MF
                </a>
              ) : (
                <span className="text-xs text-destructive">{job.error || job.status}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        Job metadata survives reload for about 24 hours, but disappears when the server restarts. Download retention is separate.
      </p>
    </aside>
  );
}

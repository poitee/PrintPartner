import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type JobEvent, type JobSnapshot } from "@print-partner/contracts";
import { EngineHttpError } from "../api/engineTransport";
import { fetchJob } from "../api/endpoints/jobs";
import { connectJobWebSocket, JobNotFoundError } from "../api/jobWebSocket";
import { invalidateAfterJob } from "../queries/invalidation";
import { invalidateAcceptedPlateExportJobs } from "../queries/acceptedPlates";
import { useHealthQuery } from "../queries/health";

export type ActiveJob = {
  jobId: string;
  kind: string;
  status: string;
  message: string;
  progress: number | null;
  profileId: number | null;
  /** When set, scopes busy UI to these source IDs; omit = all sources. */
  sourceIds?: number[];
};

type RunJobOptions = {
  profileId?: number | null;
  sourceIds?: number[];
};

type JobContextValue = {
  /** All in-flight or recently finished jobs (most recent last). */
  activeJobs: ActiveJob[];
  runJob: (
    kind: string,
    start: () => Promise<string>,
    onDone?: (snapshot: JobSnapshot) => void,
    options?: RunJobOptions,
  ) => Promise<void>;
  clearJob: (jobId?: string) => void;
  /**
   * True when a job of `kind` is pending/running.
   * When `sourceId` is set, only matches jobs that include that source
   * (or jobs with no sourceIds, which mean "all sources").
   */
  isJobKindRunning: (kind: string, sourceId?: number) => boolean;
};

const JobContext = createContext<JobContextValue | null>(null);

const JOB_TERMINAL = new Set(["done", "error", "cancelled"]);

/** Health advertises this capability only when `PP_DESKTOP_REBUILD` is exactly `1` or `true`. */
function rebuildJobSnapshots(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY) === true;
}

/**
 * How long a finished job keeps its row in the job strip.
 *
 * A job that succeeded is background work the user did not ask to read. Leaving
 * "Complete 100%" pinned to the bottom of the screen costs a fixed bar for the
 * rest of the session and, on a phone, covers real content. A failed or
 * cancelled job stays until the user dismisses it, because that one still needs
 * a decision.
 */
const DONE_JOB_LINGER_MS = 4_000;

let localFailureSequence = 0;

async function pollJobUntilTerminal(
  jobId: string,
  onProgress: (snap: JobSnapshot) => void,
  signal: AbortSignal,
  intervalMs = 400,
): Promise<void> {
  let retryDelay = intervalMs;
  for (;;) {
    if (signal.aborted) return;
    let waitMs = intervalMs;
    try {
      const snap = await fetchJob(jobId, signal);
      if (signal.aborted) return;
      retryDelay = intervalMs;
      onProgress(snap);
      if (JOB_TERMINAL.has(snap.status)) return;
    } catch (error) {
      if (signal.aborted) return;
      // An API restart must not let the fallback poll cancel socket reconnects.
      // fetch rejects network failures with TypeError; the dev proxy uses 5xx.
      if (!(error instanceof TypeError) &&
          !(error instanceof EngineHttpError && error.status >= 500)) throw error;
      waitMs = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 10_000);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}

function observationTimeoutForKind(kind: string): number | null {
  if (kind === "stl-export") return null;
  if (kind === "sync" || kind === "extract-source-docs" || kind === "import-scan") {
    return 30 * 60_000;
  }
  return 60_000;
}

function upsertJob(jobs: ActiveJob[], next: ActiveJob): ActiveJob[] {
  const idx = jobs.findIndex((j) => j.jobId === next.jobId);
  if (idx >= 0) {
    const copy = [...jobs];
    copy[idx] = next;
    return copy;
  }
  return [...jobs, next];
}

export function JobProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const health = useHealthQuery();
  const rebuildSnapshots = rebuildJobSnapshots(health.data?.capabilities);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const observers = useRef(new Set<AbortController>());
  useEffect(() => {
    const active = observers.current;
    return () => {
      for (const observer of active) observer.abort();
      active.clear();
    };
  }, []);

  const clearJob = useCallback((jobId?: string) => {
    if (jobId) {
      setActiveJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    } else {
      setActiveJobs([]);
    }
  }, []);

  // Retire succeeded jobs on their own. Failures and cancellations stay.
  useEffect(() => {
    const settled = activeJobs.filter((job) => job.status === "done");
    if (settled.length === 0) return;
    const timer = setTimeout(() => {
      const ids = new Set(settled.map((job) => job.jobId));
      setActiveJobs((prev) => prev.filter((job) => !ids.has(job.jobId)));
    }, DONE_JOB_LINGER_MS);
    return () => clearTimeout(timer);
  }, [activeJobs]);

  const isJobKindRunning = useCallback(
    (kind: string, sourceId?: number) =>
      activeJobs.some((j) => {
        if (j.kind !== kind) return false;
        if (j.status !== "pending" && j.status !== "running") return false;
        if (sourceId == null) return true;
        // Omit/empty sourceIds = unscoped busy (affects every source).
        if (j.sourceIds == null || j.sourceIds.length === 0) return true;
        return j.sourceIds.includes(sourceId);
      }),
    [activeJobs],
  );

  const runJob = useCallback(
    async (
      kind: string,
      start: () => Promise<string>,
      onDone?: (snapshot: JobSnapshot) => void,
      options?: RunJobOptions,
    ) => {
      let disconnect: (() => void) | null = null;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      const observer = new AbortController();
      observers.current.add(observer);
      observer.signal.addEventListener("abort", () => {
        finished = true;
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        disconnect?.();
        observers.current.delete(observer);
      }, { once: true });
      const sourceIds = options?.sourceIds;
      const profileId = options?.profileId ?? null;
      const removeAfterTerminalDisplay = (jobId: string) => {
        setTimeout(() => {
          setActiveJobs((prev) => prev.filter((job) => job.jobId !== jobId));
        }, 2500);
      };
      const refreshAcceptedExportHistory = () => {
        if (kind === "export-accepted-plate-3mf" && profileId != null) {
          void invalidateAcceptedPlateExportJobs(qc, profileId);
        }
      };
      try {
        const jobId = await start();
        if (observer.signal.aborted) return;
        const timeoutMs = observationTimeoutForKind(kind);
        const deadline = timeoutMs === null ? null : performance.now() + timeoutMs;
        let lastStatus: string | null = null;
        refreshAcceptedExportHistory();
        const initial: ActiveJob = {
          jobId,
          kind,
          status: "pending",
          message: "Starting…",
          progress: null,
          profileId,
          sourceIds,
        };
        setActiveJobs((prev) => upsertJob(prev, initial));

        const finish = (snap: JobSnapshot) => {
          if (finished) return;
          finished = true;
          observer.abort();
          onDone?.(snap);
          invalidateAfterJob(qc, kind, snap, options?.profileId, {
            sourceIds,
            rebuild: rebuildSnapshots,
          });
          setActiveJobs((prev) =>
            upsertJob(prev, {
              jobId,
              kind,
              status: snap.status,
              message: snap.message,
              progress: snap.progress,
              profileId,
              sourceIds,
            }),
          );
          removeAfterTerminalDisplay(jobId);
        };

        const failObservation = (error: unknown) => {
          if (finished) return;
          const message = error instanceof EngineHttpError && error.status === 404
            ? "Job not found"
            : `Lost contact with the job. It may still be running on the server. ${error instanceof Error ? error.message : String(error)}`;
          finish({ job_id: jobId, kind, status: "error", message, error: message, progress: null, result: null });
          refreshAcceptedExportHistory();
        };

        const expire = () => failObservation(new Error(
          lastStatus
            ? `Job timed out waiting for completion (last status: ${lastStatus})`
            : "Job timed out waiting for completion",
        ));

        const onProgress = (ev: JobEvent | JobSnapshot) => {
          if (finished) return;
          if (deadline !== null && performance.now() >= deadline) {
            expire();
            return;
          }
          lastStatus = ev.status;
          setActiveJobs((prev) =>
            upsertJob(prev, {
              jobId,
              kind,
              status: ev.status,
              message: ev.message,
              progress: ev.progress,
              profileId,
              sourceIds,
            }),
          );
          if (JOB_TERMINAL.has(ev.status)) {
            finish("job_id" in ev ? ev : { ...ev, job_id: jobId, kind });
          }
        };

        if (timeoutMs !== null) deadlineTimer = setTimeout(expire, timeoutMs);

        disconnect = connectJobWebSocket(
          jobId,
          onProgress,
          (error) => {
            if (error instanceof JobNotFoundError) {
              finish({ job_id: jobId, kind, status: "error", message: error.message,
                error: error.message, progress: null, result: null });
            }
            /* Other socket errors stay on this subscription. Flag off still
               finishes through HTTP polling. Rebuild mode waits for the next
               socket snapshot, including the one after reconnect. */
          },
        );

        if (!rebuildSnapshots) {
          void pollJobUntilTerminal(jobId, onProgress, observer.signal).catch(failObservation);
        }
      } catch (e) {
        if (observer.signal.aborted) return;
        observer.abort();
        localFailureSequence += 1;
        const failureJobId = `local-failure-${localFailureSequence}`;
        const message = e instanceof Error ? e.message : String(e);
        onDone?.({ job_id: failureJobId, kind, status: "error", message,
          error: message, progress: null, result: null });
        setActiveJobs((prev) =>
          upsertJob(prev, {
            jobId: failureJobId,
            kind,
            status: "error",
            message,
            progress: null,
            profileId: options?.profileId ?? null,
            sourceIds,
          }),
        );
        removeAfterTerminalDisplay(failureJobId);
      }
    },
    [qc, rebuildSnapshots],
  );

  const value = useMemo(
    () => ({ activeJobs, runJob, clearJob, isJobKindRunning }),
    [activeJobs, runJob, clearJob, isJobKindRunning],
  );

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
}

export function useJobContext() {
  const ctx = useContext(JobContext);
  if (!ctx) {
    throw new Error("useJobContext must be used within JobProvider");
  }
  return ctx;
}

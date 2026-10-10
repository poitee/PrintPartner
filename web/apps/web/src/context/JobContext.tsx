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
import type { JobEvent, JobSnapshot } from "@print-partner/contracts";
import { fetchJob } from "../api/endpoints/jobs";
import { connectJobWebSocket } from "../api/jobWebSocket";
import { invalidateAfterJob } from "../queries/invalidation";
import { invalidateAcceptedPlateExportJobs } from "../queries/acceptedPlates";

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

type ExistingExtractionJob = Readonly<{
  jobId: string;
  sourceIds?: number[];
}>;

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
  maxAttempts = 150,
): Promise<void> {
  let lastSnap: JobSnapshot | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) return;
    const snap = await fetchJob(jobId, signal);
    if (signal.aborted) return;
    lastSnap = snap;
    onProgress(snap);
    if (JOB_TERMINAL.has(snap.status)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  throw new Error(
    lastSnap
      ? `Job timed out waiting for completion (last status: ${lastSnap.status})`
      : "Job timed out waiting for completion",
  );
}

/** Sync (and similar long jobs) can exceed the default ~60s poll window once docs/PDFs are included. */
function pollAttemptsForKind(kind: string): number {
  // STL downloads have no size cap. Keep observing while the server is working.
  if (kind === "stl-export") return Number.POSITIVE_INFINITY;
  if (kind === "sync" || kind === "extract-source-docs" || kind === "import-scan") {
    return 4500; // ~30 minutes at 400ms
  }
  return 150;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceIdsFrom(values: readonly unknown[]): number[] {
  return [...new Set(values.filter((value): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0))];
}

function extractionJobsFrom(
  snapshot: JobSnapshot,
  parentSourceIds?: number[],
): ExistingExtractionJob[] {
  if (snapshot.status !== "done" || !isRecord(snapshot.result)) return [];
  const jobs = new Map<string, number[]>();
  const add = (value: unknown, sourceIds: number[]) => {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const jobId = value.trim();
    jobs.set(jobId, sourceIdsFrom([...(jobs.get(jobId) ?? []), ...sourceIds]));
  };

  if (snapshot.kind === "sync") {
    const results = snapshot.result.results;
    if (Array.isArray(results)) {
      for (const result of results) {
        if (!isRecord(result)) continue;
        add(result.pdf_extract_job_id, sourceIdsFrom([result.project_id]));
      }
    }
  } else if (snapshot.kind === "import-scan") {
    add(snapshot.result.pdf_extract_job_id, sourceIdsFrom(parentSourceIds ?? []));
  }

  return [...jobs].map(([jobId, sourceIds]) => ({
    jobId,
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
  }));
}

export function JobProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const observers = useRef(new Set<AbortController>());
  const observedExtractionJobs = useRef(new Set<string>());
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

  const observeJob = useCallback(({
    observer,
    jobId,
    kind,
    profileId,
    sourceIds,
    onDone,
    onTerminal,
    onObservationError,
  }: {
    observer: AbortController;
    jobId: string;
    kind: string;
    profileId: number | null;
    sourceIds?: number[];
    onDone?: (snapshot: JobSnapshot) => void;
    onTerminal?: (snapshot: JobSnapshot) => void;
    onObservationError?: () => void;
  }) => {
    let disconnect: (() => void) | null = null;
    let finished = false;
    observer.signal.addEventListener("abort", () => {
      finished = true;
      disconnect?.();
      observers.current.delete(observer);
    }, { once: true });
    if (observer.signal.aborted) return;

    const removeAfterTerminalDisplay = () => {
      setTimeout(() => {
        setActiveJobs((prev) => prev.filter((job) => job.jobId !== jobId));
      }, 2500);
    };
    const finish = (snapshot: JobSnapshot) => {
      if (finished) return;
      finished = true;
      observer.abort();
      onDone?.(snapshot);
      invalidateAfterJob(qc, kind, snapshot, profileId);
      setActiveJobs((prev) =>
        upsertJob(prev, {
          jobId,
          kind,
          status: snapshot.status,
          message: snapshot.message,
          progress: snapshot.progress,
          profileId,
          sourceIds,
        }),
      );
      onTerminal?.(snapshot);
      removeAfterTerminalDisplay();
    };
    const onProgress = (event: JobEvent | JobSnapshot) => {
      if (finished) return;
      setActiveJobs((prev) =>
        upsertJob(prev, {
          jobId,
          kind,
          status: event.status,
          message: event.message,
          progress: event.progress,
          profileId,
          sourceIds,
        }),
      );
      if (!JOB_TERMINAL.has(event.status)) return;
      if ("job_id" in event) {
        finish(event);
        return;
      }
      void fetchJob(jobId, observer.signal).then(finish).catch(() => undefined);
    };

    setActiveJobs((prev) =>
      upsertJob(prev, {
        jobId,
        kind,
        status: "pending",
        message: "Starting…",
        progress: null,
        profileId,
        sourceIds,
      }),
    );
    disconnect = connectJobWebSocket(jobId, onProgress, () => undefined);
    void pollJobUntilTerminal(
      jobId,
      onProgress,
      observer.signal,
      400,
      pollAttemptsForKind(kind),
    ).catch((error) => {
      if (finished) return;
      onObservationError?.();
      const message = `Lost contact with the job. It may still be running on the server. ${error instanceof Error ? error.message : String(error)}`;
      finish({
        job_id: jobId,
        kind,
        status: "error",
        message,
        error: message,
        progress: null,
        result: null,
      });
    });
  }, [qc]);

  const runJob = useCallback(
    async (
      kind: string,
      start: () => Promise<string>,
      onDone?: (snapshot: JobSnapshot) => void,
      options?: RunJobOptions,
    ) => {
      const observer = new AbortController();
      observers.current.add(observer);
      const sourceIds = options?.sourceIds;
      const profileId = options?.profileId ?? null;
      const refreshAcceptedExportHistory = () => {
        if (kind === "export-accepted-plate-3mf" && profileId != null) {
          void invalidateAcceptedPlateExportJobs(qc, profileId);
        }
      };
      try {
        const jobId = await start();
        if (observer.signal.aborted) return;
        refreshAcceptedExportHistory();
        observeJob({
          observer,
          jobId,
          kind,
          profileId,
          sourceIds,
          onDone,
          onTerminal: (snapshot) => {
            for (const child of extractionJobsFrom(snapshot, sourceIds)) {
              if (observedExtractionJobs.current.has(child.jobId)) continue;
              observedExtractionJobs.current.add(child.jobId);
              const childObserver = new AbortController();
              observers.current.add(childObserver);
              observeJob({
                observer: childObserver,
                jobId: child.jobId,
                kind: "extract-source-docs",
                profileId,
                sourceIds: child.sourceIds,
                onObservationError: () => {
                  observedExtractionJobs.current.delete(child.jobId);
                },
              });
            }
          },
        });
      } catch (e) {
        if (observer.signal.aborted) return;
        observer.abort();
        observers.current.delete(observer);
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
        setTimeout(() => {
          setActiveJobs((prev) => prev.filter((job) => job.jobId !== failureJobId));
        }, 2500);
      }
    },
    [observeJob, qc],
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

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  connectJobWebSocket,
  fetchJob,
  type JobEvent,
  type JobSnapshot,
} from "../api/engine";
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
let localFailureSequence = 0;

async function pollJobUntilTerminal(
  jobId: string,
  onProgress: (snap: JobSnapshot) => void,
  intervalMs = 400,
  maxAttempts = 150,
): Promise<JobSnapshot> {
  let lastSnap: JobSnapshot | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const snap = await fetchJob(jobId);
    lastSnap = snap;
    onProgress(snap);
    if (JOB_TERMINAL.has(snap.status)) {
      return snap;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    lastSnap
      ? `Job timed out waiting for completion (last status: ${lastSnap.status})`
      : "Job timed out waiting for completion",
  );
}

/** Sync (and similar long jobs) can exceed the default ~60s poll window once docs/PDFs are included. */
function pollAttemptsForKind(kind: string): number {
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

export function JobProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);

  const clearJob = useCallback((jobId?: string) => {
    if (jobId) {
      setActiveJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    } else {
      setActiveJobs([]);
    }
  }, []);

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
      let finished = false;
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
          disconnect?.();
          onDone?.(snap);
          invalidateAfterJob(qc, kind, snap, options?.profileId);
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

        const onProgress = (ev: JobEvent | JobSnapshot) => {
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
            void fetchJob(jobId).then(finish).catch(() => finish(ev as JobSnapshot));
          }
        };

        disconnect = connectJobWebSocket(
          jobId,
          onProgress,
          () => {
            /* WebSocket unavailable — HTTP polling fallback handles completion */
          },
        );

        void pollJobUntilTerminal(jobId, onProgress, 400, pollAttemptsForKind(kind)).catch((e) => {
          if (finished) return;
          finished = true;
          disconnect?.();
          setActiveJobs((prev) =>
            upsertJob(prev, {
              jobId,
              kind,
              status: "error",
              message: e instanceof Error ? e.message : String(e),
              progress: null,
              profileId,
              sourceIds,
            }),
          );
          refreshAcceptedExportHistory();
          removeAfterTerminalDisplay(jobId);
        });
      } catch (e) {
        localFailureSequence += 1;
        const failureJobId = `local-failure-${localFailureSequence}`;
        setActiveJobs((prev) =>
          upsertJob(prev, {
            jobId: failureJobId,
            kind,
            status: "error",
            message: e instanceof Error ? e.message : String(e),
            progress: null,
            profileId: options?.profileId ?? null,
            sourceIds,
          }),
        );
        removeAfterTerminalDisplay(failureJobId);
      }
    },
    [qc],
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

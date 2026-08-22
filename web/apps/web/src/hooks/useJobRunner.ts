import { useCallback, useState } from "react";
import { useJobContext } from "../context/JobContext";
import type { JobSnapshot } from "../api/engine";

export function useJobRunner(kind = "job", profileId?: number | null) {
  const { activeJobs, isJobKindRunning, runJob: runContextJob } = useJobContext();
  const [localMessage, setLocalMessage] = useState("");

  const jobForKind = activeJobs.find((job) =>
    job.kind === kind && (profileId == null || job.profileId === profileId));
  const busy = activeJobs.some((job) =>
    job.kind === kind &&
    (profileId == null || job.profileId === profileId) &&
    (job.status === "pending" || job.status === "running"));

  const message =
    jobForKind?.message ||
    localMessage ||
    (jobForKind ? `${jobForKind.status}` : "");

  const isBusyForSource = useCallback(
    (sourceId: number) => isJobKindRunning(kind, sourceId),
    [isJobKindRunning, kind],
  );

  const runJob = useCallback(
    async (
      start: () => Promise<string>,
      onDone?: (snapshot: JobSnapshot) => void,
      options?: { profileId?: number | null; sourceIds?: number[] },
    ) => {
      setLocalMessage("");
      await runContextJob(kind, start, onDone, options);
    },
    [kind, runContextJob],
  );

  return { busy, isBusyForSource, message, runJob };
}

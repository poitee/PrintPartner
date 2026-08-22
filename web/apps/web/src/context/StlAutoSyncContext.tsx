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
import { useLocation } from "react-router-dom";
import {
  regeneratePlanThumbnails,
  startSync,
  type PlanReview,
} from "../api/engine";
import { usePlanWorkspace } from "./PlanWorkspaceContext";
import { useProfileSelection } from "./ProfileContext";
import { useJobRunner } from "../hooks/useJobRunner";
import { isPartsPath, isLibraryPath } from "../lib/routes";
import { bumpThumbnailCache } from "../lib/thumbnailCache";
import {
  countEmptyThumbs,
  countMissingStls,
  emptyThumbPartIds,
  missingStlPartIds,
  projectIdsForStlSync,
  shouldAutoStartStlSync,
  stlAutoSyncWorkKey,
  stlSyncBannerMode,
  type StlAutoSyncTrigger,
  type StlSyncBannerMode,
} from "../lib/stlAutoSync";
import { flattenReviewParts } from "../lib/reviewParts";

type StlAutoSyncValue = {
  busy: boolean;
  failed: boolean;
  missingCount: number;
  emptyThumbCount: number;
  banner: StlSyncBannerMode;
  /** Manual Sync / retry — bypasses work-key dedupe. */
  runSync: () => void;
};

const StlAutoSyncContext = createContext<StlAutoSyncValue | null>(null);

function workKeyForReview(profileId: number, review: PlanReview): string {
  const parts = flattenReviewParts(review.part_groups);
  return stlAutoSyncWorkKey(
    profileId,
    missingStlPartIds(parts),
    emptyThumbPartIds(parts),
  );
}

async function regenThumbs(profileId: number): Promise<void> {
  try {
    await regeneratePlanThumbnails(profileId);
  } catch {
    // Clear may fail if no cache yet — still bump so PartThumb re-probes / renders.
  }
  bumpThumbnailCache();
}

export function StlAutoSyncProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { selectedProfileId } = useProfileSelection();
  const { review, refresh } = usePlanWorkspace();
  const syncJob = useJobRunner("sync");
  const [failed, setFailed] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const attemptedWorkKeyRef = useRef<string | null>(null);
  const prevProfileRef = useRef<number | null>(null);
  const prevPartsPathRef = useRef(false);
  const prevWorkKeyRef = useRef<string | null>(null);
  const runInFlightRef = useRef(false);

  const parts = useMemo(
    () => (review ? flattenReviewParts(review.part_groups) : []),
    [review],
  );
  const missingCount = useMemo(() => countMissingStls(parts), [parts]);
  const emptyThumbCount = useMemo(() => countEmptyThumbs(parts), [parts]);
  const busy = syncJob.busy || localBusy;

  const banner = useMemo(
    () => stlSyncBannerMode({ running: busy, failed, missingCount }),
    [busy, failed, missingCount],
  );

  const execute = useCallback(
    async (opts: { force: boolean; workKey: string }) => {
      if (selectedProfileId == null || !review) return;
      if (runInFlightRef.current || syncJob.busy) return;
      if (!opts.force && attemptedWorkKeyRef.current === opts.workKey) return;

      const needSync = missingCount > 0 || review.layers.some((l) => !l.synced);
      const needThumbs = emptyThumbCount > 0 || needSync;
      if (!needSync && !needThumbs) return;

      attemptedWorkKeyRef.current = opts.workKey;
      runInFlightRef.current = true;
      setFailed(false);

      const clearInFlight = () => {
        setLocalBusy(false);
        runInFlightRef.current = false;
      };

      const finishFail = () => {
        setFailed(true);
        clearInFlight();
      };

      const finishOk = async () => {
        try {
          if (selectedProfileId != null) {
            await refresh();
            if (needThumbs) await regenThumbs(selectedProfileId);
          }
        } catch {
          finishFail();
          return;
        } finally {
          // Always unlock so a later Sync is not stuck no-op'ing.
          if (runInFlightRef.current) clearInFlight();
        }
      };

      if (needSync) {
        const ids = projectIdsForStlSync(review);
        if (ids.length === 0) {
          // Nothing to pull — still try thumbs if flagged.
          setLocalBusy(true);
          try {
            if (needThumbs) await regenThumbs(selectedProfileId);
            await refresh();
          } catch {
            finishFail();
            return;
          } finally {
            if (runInFlightRef.current) clearInFlight();
          }
          return;
        }
        void syncJob.runJob(
          () => startSync(ids),
          (snap) => {
            if (snap.status === "error") {
              finishFail();
              return;
            }
            void finishOk();
          },
          { profileId: selectedProfileId, sourceIds: ids },
        );
        return;
      }

      // Thumbs-only coordinated path (no missing STLs).
      setLocalBusy(true);
      try {
        await regenThumbs(selectedProfileId);
      } catch {
        finishFail();
        return;
      } finally {
        if (runInFlightRef.current) clearInFlight();
      }
    },
    [
      selectedProfileId,
      review,
      missingCount,
      emptyThumbCount,
      syncJob,
      refresh,
    ],
  );

  const runSync = useCallback(() => {
    if (selectedProfileId == null || !review) return;
    const key = workKeyForReview(selectedProfileId, review);
    void execute({ force: true, workKey: key });
  }, [selectedProfileId, review, execute]);

  // Auto-start: plan select, Parts open, compose apply (work key change). Never Progress ticks.
  useEffect(() => {
    const profileId = selectedProfileId;
    const onParts = isPartsPath(location.pathname);

    if (profileId == null) {
      attemptedWorkKeyRef.current = null;
      prevWorkKeyRef.current = null;
      prevProfileRef.current = null;
      prevPartsPathRef.current = onParts;
      return;
    }

    if (!review || review.profile_id !== profileId) {
      // Keep prevProfileRef unset until review is ready so plan_select still fires.
      prevPartsPathRef.current = onParts;
      return;
    }

    const workKey = workKeyForReview(profileId, review);
    let trigger: StlAutoSyncTrigger | null = null;

    if (isLibraryPath(location.pathname) && profileId == null) {
      trigger = "library_no_plan";
    } else if (prevProfileRef.current !== profileId) {
      // Plan select/switch — re-allow auto-start when returning to a plan.
      attemptedWorkKeyRef.current = null;
      trigger = "plan_select";
    } else if (onParts && !prevPartsPathRef.current) {
      trigger = "parts_open";
    } else if (
      prevWorkKeyRef.current != null &&
      prevWorkKeyRef.current !== workKey &&
      (missingCount > 0 || emptyThumbCount > 0)
    ) {
      // Compose / recompute / sync changed which files are missing or empty.
      // Not fired by Progress checkoff ticks (work key ignores print progress).
      trigger = "compose_apply";
    }
    // Intentionally no Progress-tick trigger.

    prevProfileRef.current = profileId;
    prevPartsPathRef.current = onParts;
    prevWorkKeyRef.current = workKey;

    if (!trigger) return;

    if (
      !shouldAutoStartStlSync({
        profileId,
        trigger,
        missingStlCount: missingCount,
        emptyThumbCount,
        alreadyRunning: busy || runInFlightRef.current,
        attemptedWorkKey: attemptedWorkKeyRef.current,
        workKey,
      })
    ) {
      return;
    }

    void execute({ force: false, workKey });
  }, [
    selectedProfileId,
    review,
    location.pathname,
    missingCount,
    emptyThumbCount,
    busy,
    execute,
  ]);

  const value = useMemo(
    () => ({
      busy,
      failed,
      missingCount,
      emptyThumbCount,
      banner,
      runSync,
    }),
    [busy, failed, missingCount, emptyThumbCount, banner, runSync],
  );

  return (
    <StlAutoSyncContext.Provider value={value}>{children}</StlAutoSyncContext.Provider>
  );
}

export function useStlAutoSync(): StlAutoSyncValue {
  const ctx = useContext(StlAutoSyncContext);
  if (!ctx) {
    throw new Error("useStlAutoSync must be used within StlAutoSyncProvider");
  }
  return ctx;
}

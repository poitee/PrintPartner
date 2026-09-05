import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckSquare } from "lucide-react";
import { toast } from "sonner";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import PageShell from "../components/layout/PageShell";
import BuildSummaryHeader from "../components/build/BuildSummaryHeader";
import PlanSpecialRequestLine from "../components/PlanSpecialRequestLine";
// Lazy: PrinterLiveStrip starts polling on mount — defer until rendered
const PrinterLiveStrip = lazy(() => import("../components/checkoff/PrinterLiveStrip"));
import type { PrinterLiveStripState } from "../components/checkoff/PrinterLiveStrip";
import type { PrintVerifyQueueState } from "../components/checkoff/PrintVerifyPanel";
import PhaseProgressView from "../components/checkoff/PhaseProgressView";
import PartPreviewDialog from "../components/parts/PartPreviewDialog";
import CheckoffAttentionView from "../components/checkoff/CheckoffAttentionView";
import CheckoffCompletionCard from "../components/checkoff/CheckoffCompletionCard";
import CheckoffConsoleErrors from "../components/checkoff/CheckoffConsoleErrors";
import CheckoffEmptyState from "../components/checkoff/CheckoffEmptyState";
import CheckoffCorrectionDialog, {
  type CheckoffCorrectionTarget,
} from "../components/checkoff/CheckoffCorrectionDialog";
import CheckoffMoveToDialog, {
  type CheckoffMoveTarget,
} from "../components/checkoff/CheckoffMoveToDialog";
import CheckoffPrinterStatusCard from "../components/checkoff/CheckoffPrinterStatusCard";
import PastPrintIntakePanel from "../components/checkoff/PastPrintIntakePanel";
import CheckoffPrintSheet from "../components/checkoff/CheckoffPrintSheet";
import CheckoffPrintSheetButton, {
  type PrintSheetLayout,
} from "../components/checkoff/CheckoffPrintSheetButton";
import CheckoffStateNotice from "../components/checkoff/CheckoffStateNotice";
import CheckoffViewTabs from "../components/checkoff/CheckoffViewTabs";
import CheckoffWorklist from "../components/checkoff/CheckoffWorklist";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Progress } from "../components/ui/progress";
import { claimUnattributedPrint } from "../api/endpoints/checkoff";
import type { ReviewPart } from "../api/endpoints/planManifests";
import { useBuildTrackingSettingsQuery } from "../queries/buildTracking";
import { useBuildWorkflowQuery } from "../queries/buildWorkflow";
import {
  planRoute,
  prepareMissingPartsRoute,
  printersRoute,
  productionRoute,
} from "../lib/routes";
import { groupCheckoffParts } from "../lib/checkoffGroups";
import {
  checkoffUnitTotals,
  formatPrintedUnitsLine,
  lastCompletedUnit,
  nextUnitToComplete,
} from "../lib/checkoffProgress";
import {
  checkoffProgressDescription,
  checkoffProgressEyebrow,
  checkoffProgressMeta,
  filterProgressRows,
  isSameLiveStripState,
  orderedPartsFromRows,
  searchCheckoffParts,
} from "../lib/checkoffPageModel";
import { useCheckoffPrinterActivity } from "../lib/checkoffConsoleActivity";
import { useCheckoffProgressMutations } from "../lib/checkoffConsoleMutations";
import {
  buildCheckoffAttentionItems,
  checkoffConsoleHeadline,
  checkoffViewCounts,
  partsForCheckoffView,
  resolveCheckoffCompletion,
  resolveCheckoffView,
  type CheckoffViewId,
} from "../lib/checkoffConsoleModel";
import {
  checkoffCorrectionImpact,
  checkoffCorrectionNeedsReason,
  type CheckoffCorrectionReason,
} from "../lib/checkoffConsoleCorrection";
import { moveCheckoffRowToPosition } from "../lib/checkoffConsoleReorder";
import { checkoffRowErrorSummary } from "../lib/checkoffConsoleRowErrors";
import {
  getCheckoffCompletedAt,
  getCheckoffCorrections,
  getCheckoffSearch,
  latestCorrectionsByPart,
  loadCheckoffConsolePreferences,
  saveCheckoffConsolePreferences,
  withCheckoffCompletedAt,
  withCheckoffCorrection,
  withCheckoffSearch,
} from "../lib/checkoffConsolePreferences";
import { useCheckoffWorklistOrder } from "../lib/checkoffConsoleOrder";
import { computePhaseProgress } from "../lib/phaseManifest";
import {
  loadPersistedCheckoffUi,
  savePersistedCheckoffUi,
} from "../lib/persistedCheckoffUi";
import {
  mergeVisibleProgressReorder,
  type ProgressRowRef,
} from "../lib/progressListOrder";
import { buildCheckoffPrinterActivityParts } from "../lib/checkoffPrinterActivity";
import { flattenReviewParts } from "../lib/reviewParts";
import { useProfileSelection } from "../context/ProfileContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { waitForSheetThumbnails } from "../lib/waitForSheetThumbnails";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
} from "../lib/workflowState";
import PwaInstallBanner from "../components/pwa/PwaInstallBanner";
import { useSyncComplete } from "../lib/useSyncComplete";

/**
 * Checkoff: the operator console beside the printer.
 *
 * It answers one question — what physical result needs my attention? — and
 * splits the answer into three views, so a finished printer job never competes
 * with the manual worklist. This page also owns printer evidence: live watched
 * jobs, missed jobs recovered from printer storage, and files from printers
 * PrintPartner cannot monitor. New-work preparation and dispatch stay in
 * Production.
 *
 * View selection, grouping, row state, correction rules, and recovery live in
 * `lib/checkoffConsole*`. This file is composition.
 */
export default function CheckoffPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const engineReady = Boolean(health?.ok);
  const {
    selectedProfileId,
    profiles,
    loading: profilesLoading,
    error: profilesError,
    reloadProfiles,
  } = useProfileSelection();
  const {
    review,
    loading,
    error: workspaceError,
    refresh,
    toggleUnit,
    toggleAssembled,
    busyPartId,
  } = usePlanWorkspace();
  const isMobileLayout = useMediaQuery("(max-width: 767px)");
  const { data: buildTrackingSettings, error: buildTrackingError } =
    useBuildTrackingSettingsQuery(engineReady);
  const assemblyTrackingEnabled = buildTrackingSettings?.assembly_tracking ?? false;
  const { data: workflow } = useBuildWorkflowQuery(selectedProfileId, engineReady);

  const trackingError = useMemo(
    () => ({
      key: "assembly-tracking",
      message: buildTrackingError
        ? `Could not load assembly tracking settings: ${
            buildTrackingError instanceof Error
              ? buildTrackingError.message
              : String(buildTrackingError)
          }`
        : null,
    }),
    [buildTrackingError],
  );

  const activity = useCheckoffPrinterActivity({
    engineReady,
    profileId: selectedProfileId,
    externalError: trackingError,
  });

  // Re-fetch when the service worker flushes its offline checkoff queue
  useSyncComplete(
    useCallback(() => {
      if (selectedProfileId != null) void refresh();
    }, [refresh, selectedProfileId]),
  );

  const persistedUi = useMemo(() => loadPersistedCheckoffUi(), []);
  const [printLayout, setPrintLayout] = useState<PrintSheetLayout>({
    compactMode: persistedUi.compactMode,
    continuousPrintLayout: persistedUi.continuousPrintLayout,
    textOnlyPrint: persistedUi.textOnlyPrint,
  });
  const [consolePrefs, setConsolePrefs] = useState(() => loadCheckoffConsolePreferences());
  const [requestedView, setRequestedView] = useState<CheckoffViewId | null>(
    () => consolePrefs.view,
  );
  const search = getCheckoffSearch(consolePrefs, selectedProfileId);
  const [previewPart, setPreviewPart] = useState<ReviewPart | null>(null);
  const [printPrep, setPrintPrep] = useState(false);
  const [pastPrintOpen, setPastPrintOpen] = useState(
    () => searchParams.get("add") === "past-print",
  );
  const [verifyRefreshKey, setVerifyRefreshKey] = useState(0);
  const [correctionTarget, setCorrectionTarget] =
    useState<CheckoffCorrectionTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<CheckoffMoveTarget | null>(null);
  const [liveStrip, setLiveStrip] = useState<PrinterLiveStripState>({
    anyPrinting: false,
    activeIntegrationIds: [],
    idleIntegrationIds: [],
    hostCount: 0,
  });
  const updateLiveStrip = useCallback((next: PrinterLiveStripState) => {
    setLiveStrip((current) => (isSameLiveStripState(current, next) ? current : next));
  }, []);
  const [verifyQueue, setVerifyQueue] = useState<PrintVerifyQueueState>({
    awaitingCount: 0,
    watchingCount: 0,
    primaryHostName: null,
  });
  const sheetRef = useRef<HTMLElement>(null);
  const mutations = useCheckoffProgressMutations();
  const { runMutation, retryRow, clearAll: clearRowErrors } = mutations;

  useEffect(() => {
    if (searchParams.get("add") === "past-print") setPastPrintOpen(true);
  }, [searchParams]);

  const openPastPrintIntake = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.set("add", "past-print");
    setSearchParams(next, { replace: true });
    setPastPrintOpen(true);
  }, [searchParams, setSearchParams]);

  const closePastPrintIntake = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("add");
    setSearchParams(next, { replace: true });
    setPastPrintOpen(false);
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const onBeforePrint = () => setPrintPrep(true);
    const onAfterPrint = () => setPrintPrep(false);
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    };
  }, []);

  const onPrint = useCallback(async () => {
    setPrintPrep(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const sheet = sheetRef.current;
    if (!sheet) {
      setPrintPrep(false);
      return;
    }
    if (!printLayout.textOnlyPrint) {
      const { pending } = await waitForSheetThumbnails(sheet);
      if (pending > 0) {
        toast.warning(
          pending === 1
            ? "1 part picture was not ready. The sheet printed anyway."
            : `${pending} part pictures were not ready. The sheet printed anyway.`,
        );
      }
    }
    window.print();
  }, [printLayout.textOnlyPrint]);

  useEffect(() => {
    setVerifyQueue({ awaitingCount: 0, watchingCount: 0, primaryHostName: null });
    clearRowErrors();
  }, [clearRowErrors, selectedProfileId]);

  useEffect(() => {
    savePersistedCheckoffUi({
      ...loadPersistedCheckoffUi(),
      compactMode: printLayout.compactMode,
      continuousPrintLayout: printLayout.continuousPrintLayout,
      textOnlyPrint: printLayout.textOnlyPrint,
    });
  }, [printLayout]);

  useEffect(() => {
    saveCheckoffConsolePreferences(consolePrefs);
  }, [consolePrefs]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
  const planName = selectedProfile?.name ?? review?.plan_name ?? "Checkoff";
  const specialRequest = selectedProfile?.special_request ?? null;

  const includedParts = useMemo(() => {
    if (!review) return [];
    return flattenReviewParts(review.part_groups).filter((p) => p.included);
  }, [review]);

  const { printingPartIds, awaitingPartIds, suggestedPartIds } = useMemo(
    () =>
      buildCheckoffPrinterActivityParts({
        watchingLinks: activity.watchingLinks,
        awaitingLinks: activity.awaitingLinks,
        unattributedPrints: activity.unattributedPrints,
        includedParts,
      }),
    [activity.watchingLinks, activity.awaitingLinks, activity.unattributedPrints, includedParts],
  );

  const partsById = useMemo(() => {
    const map = new Map<number, ReviewPart>();
    for (const p of includedParts) map.set(p.id, p);
    return map;
  }, [includedParts]);

  const includedPartIds = useMemo(() => includedParts.map((p) => p.id), [includedParts]);
  const worklistOrder = useCheckoffWorklistOrder({
    planId: selectedProfileId,
    partIds: includedPartIds,
  });
  const planProgressRows = worklistOrder.rows;

  const attentionItems = useMemo(
    () =>
      buildCheckoffAttentionItems({
        awaitingLinks: activity.awaitingLinks,
        failedLinks: activity.failedLinks,
        unattributedPrints: activity.unattributedPrints,
      }),
    [activity.awaitingLinks, activity.failedLinks, activity.unattributedPrints],
  );

  const viewCounts = useMemo(
    () => checkoffViewCounts({ attentionItems, parts: includedParts }),
    [attentionItems, includedParts],
  );
  const view = resolveCheckoffView({ requested: requestedView, counts: viewCounts });

  const filteredParts = useMemo(
    () =>
      searchCheckoffParts({
        parts: partsForCheckoffView({ parts: includedParts, view }),
        search,
      }),
    [includedParts, search, view],
  );

  const filteredRows = useMemo(() => {
    const visiblePartIds = new Set(filteredParts.map((part) => part.id));
    const rows = filterProgressRows({ rows: planProgressRows, visiblePartIds, search });
    return view === "remaining" ? rows : rows.filter((row) => row.kind === "part");
  }, [filteredParts, planProgressRows, search, view]);

  const sheetParts = useMemo(
    () => orderedPartsFromRows({ rows: planProgressRows, partsById }),
    [partsById, planProgressRows],
  );

  const setWorklistRows = worklistOrder.setRows;
  const onReorderVisibleRows = useCallback(
    (nextVisible: ProgressRowRef[]) => {
      setWorklistRows(
        mergeVisibleProgressReorder(planProgressRows, filteredRows, nextVisible),
      );
    },
    [filteredRows, planProgressRows, setWorklistRows],
  );

  const setSearch = useCallback(
    (value: string) => {
      if (selectedProfileId == null) return;
      setConsolePrefs((prev) => withCheckoffSearch(prev, selectedProfileId, value));
    },
    [selectedProfileId],
  );

  const onSelectView = useCallback((next: CheckoffViewId) => {
    setRequestedView(next);
    setConsolePrefs((prev) => ({ ...prev, view: next }));
  }, []);

  const sheetGroups = useMemo(() => groupCheckoffParts(sheetParts), [sheetParts]);
  const phaseProgress = useMemo(() => {
    const manifest = activity.phaseManifest;
    if (!manifest?.has_phases || manifest.phases.length === 0) return null;
    return computePhaseProgress(
      {
        profile_id: manifest.profile_id,
        has_phases: manifest.has_phases,
        phases: manifest.phases,
      },
      includedParts,
    );
  }, [activity.phaseManifest, includedParts]);
  const totals = useMemo(() => checkoffUnitTotals(includedParts), [includedParts]);
  const printedLine = useMemo(() => formatPrintedUnitsLine(includedParts), [includedParts]);
  const toggleBusy = busyPartId != null;

  const acceptedPlan = workflow?.accepted_plan;
  const completion = useMemo(
    () =>
      resolveCheckoffCompletion({
        totalUnits: totals.totalUnits,
        printedUnits: totals.printedUnits,
        partCount: includedParts.length,
        completedAt: getCheckoffCompletedAt(consolePrefs, selectedProfileId),
        planVersion: acceptedPlan?.kind === "ready" ? acceptedPlan.plan_version : null,
        revisionId: acceptedPlan?.kind === "ready" ? acceptedPlan.revision_id : null,
      }),
    [acceptedPlan, consolePrefs, includedParts.length, selectedProfileId, totals],
  );

  // Record when the Build first reached "every Required unit verified".
  useEffect(() => {
    if (selectedProfileId == null) return;
    if (review == null || review.profile_id !== selectedProfileId) return;
    if (completion.kind === "complete") {
      const at = new Date().toISOString();
      setConsolePrefs((prev) => withCheckoffCompletedAt(prev, selectedProfileId, at));
      return;
    }
    setConsolePrefs((prev) =>
      getCheckoffCompletedAt(prev, selectedProfileId) == null
        ? prev
        : withCheckoffCompletedAt(prev, selectedProfileId, null),
    );
  }, [completion.kind, review, selectedProfileId]);

  const correctionsByPart = useMemo(
    () => latestCorrectionsByPart(getCheckoffCorrections(consolePrefs, selectedProfileId)),
    [consolePrefs, selectedProfileId],
  );

  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const profilesState = resolveResourceState({
    loading: profilesLoading,
    error: profilesError,
    hasData: profiles.length > 0,
  });
  const reviewState = resolveResourceState({
    loading,
    error: workspaceError,
    hasData: review != null,
  });

  const suppressIntegrationIds = useMemo(
    () => new Set(liveStrip.activeIntegrationIds),
    [liveStrip.activeIntegrationIds],
  );

  const progressEyebrow = checkoffProgressEyebrow(
    checkoffProgressMeta({
      selectedProfileId,
      planName,
      includedPartCount: includedParts.length,
    }),
  );
  const progressDescription = checkoffProgressDescription(includedParts.length);

  const onToggleUnit = useCallback(
    (part: ReviewPart, unitIndex: number) => {
      const next = !part.print_units[unitIndex];
      runMutation({
        part,
        action: next ? "checkoff" : "correction",
        run: () => toggleUnit(part.id, unitIndex, next),
      });
    },
    [runMutation, toggleUnit],
  );

  const onToggleAssembled = useCallback(
    (part: ReviewPart, unitIndex: number) => {
      const next = !(part.assembled_units?.[unitIndex] ?? false);
      runMutation({
        part,
        action: "assembly",
        run: () => toggleAssembled(part.id, unitIndex, next),
      });
    },
    [runMutation, toggleAssembled],
  );

  const onIncrement = useCallback(
    (part: ReviewPart) => {
      const idx = nextUnitToComplete(part.print_units);
      if (idx < 0) return;
      runMutation({ part, action: "checkoff", run: () => toggleUnit(part.id, idx, true) });
    },
    [runMutation, toggleUnit],
  );

  const decrementPart = useCallback(
    (part: ReviewPart) => {
      const idx = lastCompletedUnit(part.print_units);
      if (idx < 0) return;
      runMutation({ part, action: "correction", run: () => toggleUnit(part.id, idx, false) });
    },
    [runMutation, toggleUnit],
  );

  const onDecrement = useCallback(
    (part: ReviewPart) => {
      if (lastCompletedUnit(part.print_units) < 0) return;
      const impact = checkoffCorrectionImpact({
        printingOn: printingPartIds.get(part.id),
        awaitingVerify: awaitingPartIds.get(part.id),
        filamentDisplay: part.filament_display,
      });
      if (!checkoffCorrectionNeedsReason(impact)) {
        decrementPart(part);
        return;
      }
      setCorrectionTarget({
        partId: part.id,
        filename: part.filename,
        printedCount: part.printed_count,
        impact,
      });
    },
    [awaitingPartIds, decrementPart, printingPartIds],
  );

  const onConfirmCorrection = useCallback(
    (input: { reason: CheckoffCorrectionReason | null; note: string }) => {
      const target = correctionTarget;
      setCorrectionTarget(null);
      if (!target) return;
      const part = partsById.get(target.partId);
      if (!part) return;
      const reason = input.reason;
      if (reason && selectedProfileId != null) {
        setConsolePrefs((prev) =>
          withCheckoffCorrection(prev, selectedProfileId, {
            partId: part.id,
            unitIndex: lastCompletedUnit(part.print_units),
            reason,
            note: input.note,
            at: new Date().toISOString(),
          }),
        );
      }
      decrementPart(part);
    },
    [correctionTarget, decrementPart, partsById, selectedProfileId],
  );

  const onClaimSuggestion = useCallback(
    (suggestion: { printId: string; stlBasename: string }) => {
      if (selectedProfileId == null) return;
      void claimUnattributedPrint(suggestion.printId, selectedProfileId, {
        selected_stl_basenames: [suggestion.stlBasename],
      })
        .then(() => {
          activity.markSuccess("claim-printer-activity");
          void activity.refreshUnattributed();
          activity.refreshLinks();
        })
        .catch((e) =>
          activity.reportError(
            "claim-printer-activity",
            `Could not claim printer activity: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    },
    [activity, selectedProfileId],
  );

  const renderEmpty = () => (
    <CheckoffEmptyState
      planSelected={selectedProfileId != null}
      hasParts={review != null && includedParts.length > 0}
      searching={search.trim().length > 0}
      view={view}
      onOpenPlan={() => navigate(planRoute(selectedProfileId))}
      onClearSearch={() => setSearch("")}
      onSelectView={onSelectView}
    />
  );

  if (
    engineState !== "ready" ||
    profilesState !== "ready" ||
    selectedProfileId == null ||
    reviewState !== "ready"
  ) {
    return (
      <PageShell>
        <PageHeader
          icon={CheckSquare}
          accent
          eyebrow={progressEyebrow}
          title="Checkoff"
          description={progressDescription}
        />
        <BuildSummaryHeader currentStageId="checkoff" className="no-print" />
        <CheckoffStateNotice
          engineState={engineState}
          profilesState={profilesState}
          reviewState={reviewState}
          profilesError={profilesError}
          workspaceError={workspaceError}
          onReloadProfiles={() => void reloadProfiles()}
          onRetryReview={() => {
            if (selectedProfileId != null) void refresh();
          }}
          emptyState={renderEmpty()}
        />
      </PageShell>
    );
  }

  const headline = checkoffConsoleHeadline({
    counts: viewCounts,
    printingJobs: workflow?.active_work.printing_jobs ?? verifyQueue.watchingCount,
    remainingUnits: totals.remainingUnits,
  });

  return (
    <PageShell>
      <div className="no-print space-y-4">
        <PageHeader
          icon={CheckSquare}
          accent
          eyebrow={progressEyebrow}
          title="Checkoff"
          description={progressDescription}
          actions={
            /* On a phone the sheet is a bench task, so it sits with the other
               low-frequency actions at the end of the page. */
            isMobileLayout ? undefined : (
              <PageHeaderActions>
                <CheckoffPrintSheetButton
                  layout={printLayout}
                  onLayoutChange={setPrintLayout}
                  onPrint={() => void onPrint()}
                  disabled={sheetParts.length === 0}
                />
              </PageHeaderActions>
            )
          }
        />

        <BuildSummaryHeader currentStageId="checkoff" className="no-print" />

        <PwaInstallBanner />

        <PlanSpecialRequestLine note={specialRequest} />

        <CheckoffPrinterStatusCard
          className="no-print"
          printingJobs={workflow?.active_work.printing_jobs ?? 0}
          queuedJobs={workflow?.active_work.queued_jobs ?? 0}
          failedJobs={workflow?.active_work.failed_jobs ?? 0}
          printersRoute={printersRoute()}
          onAddPastPrint={openPastPrintIntake}
        >
          <Suspense
            fallback={
              <p className="text-xs text-muted-foreground" role="status">
                Loading live printer activity…
              </p>
            }
          >
            <PrinterLiveStrip
              engineReady={engineReady}
              onLiveStateChange={updateLiveStrip}
              onCheckoffUpdate={(profileId) => {
                if (profileId === selectedProfileId) setVerifyRefreshKey((k) => k + 1);
                activity.refreshLinks();
              }}
              onUnattributedUpdate={() => {
                void activity.refreshUnattributed();
              }}
            />
          </Suspense>
        </CheckoffPrinterStatusCard>

        {completion.kind === "complete" ? (
          <CheckoffCompletionCard
            buildName={planName}
            totalUnits={completion.totalUnits}
            partCount={completion.partCount}
            completedAt={completion.completedAt}
            planVersion={completion.planVersion}
            revisionId={completion.revisionId}
            planHref={planRoute(selectedProfileId)}
            productionHref={productionRoute(selectedProfileId)}
            onPrintSheet={() => void onPrint()}
          />
        ) : null}

        <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
          <p className="min-w-0 flex-1 text-sm font-medium text-foreground" role="status">
            {headline}
          </p>
          {includedParts.length > 0 && (
            <div className="flex items-center gap-3">
              <Progress
                value={totals.percent}
                tone="success"
                className="h-1.5 w-16 shrink-0"
                aria-label={`${totals.percent}% of print units verified`}
              />
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {totals.printedUnits} / {totals.totalUnits} verified
              </span>
            </div>
          )}
        </div>

        <CheckoffViewTabs value={view} counts={viewCounts} onValueChange={onSelectView} />

        <CheckoffConsoleErrors
          profilesError={getBackgroundError(profilesError, profiles.length > 0)}
          reviewError={getBackgroundError(workspaceError, review != null)}
          auxiliaryError={activity.auxiliaryError}
          rowErrors={checkoffRowErrorSummary(mutations.rowErrors)}
        />
      </div>

      {view === "attention" ? (
        <CheckoffAttentionView
          items={attentionItems}
          engineReady={engineReady}
          profileId={selectedProfileId}
          parts={includedParts}
          refreshKey={verifyRefreshKey}
          links={{
            watching: activity.watchingLinks,
            awaiting: activity.awaitingLinks,
            failed: activity.failedLinks,
          }}
          unattributedPrints={activity.unattributedPrints}
          profiles={profiles}
          suppressIntegrationIds={suppressIntegrationIds}
          onActivityRefresh={activity.refreshLinks}
          onQueueChange={setVerifyQueue}
          onVerified={() => {
            void refresh();
            activity.refreshLinks();
          }}
          onClaimed={() => {
            void activity.refreshUnattributed();
            activity.refreshLinks();
            setVerifyRefreshKey((k) => k + 1);
          }}
          onDismissed={() => void activity.refreshUnattributed()}
          onOpenWorklist={() => onSelectView("remaining")}
        />
      ) : (
        <>
          <div className="no-print flex items-center gap-2">
            <input
              type="search"
              aria-label="Search progress parts"
              className="checkoff-search min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base sm:text-sm"
              placeholder="Search parts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={toggleBusy}
            />
            {view === "remaining" && (
              <Button
                type="button"
                variant="secondary"
                className="min-h-11 shrink-0 px-3"
                disabled={toggleBusy}
                onClick={worklistOrder.addBagBar}
              >
                Add bag
              </Button>
            )}
          </div>

          {view === "remaining" && phaseProgress ? (
            <PhaseProgressView
              phases={phaseProgress}
              busyPartId={busyPartId}
              assemblyTrackingEnabled={assemblyTrackingEnabled}
              onIncrement={onIncrement}
              onDecrement={onDecrement}
              onPreview={setPreviewPart}
              onToggleAssembled={onToggleAssembled}
              printingPartIds={printingPartIds}
              awaitingPartIds={awaitingPartIds}
            />
          ) : (
            <CheckoffWorklist
              rows={filteredRows}
              partsById={partsById}
              mobile={isMobileLayout}
              busyPartId={busyPartId}
              toggleBusy={toggleBusy}
              assemblyTrackingEnabled={assemblyTrackingEnabled}
              printingPartIds={printingPartIds}
              awaitingPartIds={awaitingPartIds}
              suggestedPartIds={suggestedPartIds}
              rowErrors={mutations.rowErrors}
              correctionsByPart={correctionsByPart}
              reorderable={view === "remaining"}
              emptyState={<div className="no-print">{renderEmpty()}</div>}
              onReorder={onReorderVisibleRows}
              onMoveTo={setMoveTarget}
              onToggleUnit={onToggleUnit}
              onIncrement={onIncrement}
              onDecrement={onDecrement}
              onPreview={setPreviewPart}
              onClaim={onClaimSuggestion}
              onToggleAssembled={onToggleAssembled}
              onRetryRow={retryRow}
              onBagLabelChange={worklistOrder.renameBagBar}
              onRemoveBagBar={worklistOrder.removeBagBar}
            />
          )}
        </>
      )}

      {sheetParts.length > 0 ? (
        <CheckoffPrintSheet
          sheetRef={sheetRef}
          planName={planName}
          partCount={sheetParts.length}
          printedLine={printedLine}
          groups={sheetGroups}
          layout={printLayout}
          printPrep={printPrep}
          busyPartId={busyPartId}
          toggleBusy={toggleBusy}
          onToggleUnit={onToggleUnit}
          onPreview={setPreviewPart}
        />
      ) : null}

      {review && (
        <div className="no-print flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {isMobileLayout && (
            <CheckoffPrintSheetButton
              layout={printLayout}
              onLayoutChange={setPrintLayout}
              onPrint={() => void onPrint()}
              disabled={sheetParts.length === 0}
            />
          )}
          <Button className="min-h-11 w-full sm:w-auto" variant="ghost" asChild>
            <Link to={planRoute(selectedProfileId)}>Back to Plan</Link>
          </Button>
          <Button className="min-h-11 w-full sm:w-auto" variant="ghost" asChild>
            <Link to={prepareMissingPartsRoute(selectedProfileId)}>
              Prepare remaining units in Production
            </Link>
          </Button>
        </div>
      )}

      <CheckoffCorrectionDialog
        target={correctionTarget}
        busy={toggleBusy}
        onCancel={() => setCorrectionTarget(null)}
        onConfirm={onConfirmCorrection}
      />

      <Dialog
        open={pastPrintOpen}
        onOpenChange={(open) => {
          if (!open) closePastPrintIntake();
        }}
      >
        <DialogContent
          className="max-w-4xl"
          aria-describedby="past-print-intake-description"
        >
          <DialogHeader>
            <DialogTitle>Add a past print to {planName}</DialogTitle>
            <p id="past-print-intake-description" className="text-sm text-muted-foreground">
              Choose a file from a watched printer or upload one from this computer, then confirm
              which Required units it made. You can add several prints and use a different printer
              for each one.
            </p>
          </DialogHeader>
          <PastPrintIntakePanel
            profileId={selectedProfileId}
            onRecorded={() => {
              void activity.refreshUnattributed();
              activity.refreshLinks();
              setVerifyRefreshKey((key) => key + 1);
            }}
            onProgressChanged={() => {
              activity.refreshLinks();
              setVerifyRefreshKey((key) => key + 1);
              void refresh();
              void reloadProfiles();
            }}
          />
        </DialogContent>
      </Dialog>

      <CheckoffMoveToDialog
        target={moveTarget}
        onCancel={() => setMoveTarget(null)}
        onMove={(position) => {
          if (!moveTarget) return;
          onReorderVisibleRows(
            moveCheckoffRowToPosition(filteredRows, moveTarget.sortableId, position),
          );
          setMoveTarget(null);
        }}
      />

      <PartPreviewDialog part={previewPart} onClose={() => setPreviewPart(null)} />
    </PageShell>
  );
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ClipboardCheck, CheckSquare, Printer } from "lucide-react";
import { toast } from "sonner";
import PlanFreshnessNotice from "../components/PlanFreshnessNotice";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import RouteBreadcrumbs from "../components/layout/RouteBreadcrumbs";
import DeskNextStep from "../components/layout/DeskNextStep";
import EmptyState from "../components/layout/EmptyState";
import PlanSpecialRequestLine from "../components/PlanSpecialRequestLine";
// Lazy: PrinterLiveStrip starts polling on mount — defer until rendered
const PrinterLiveStrip = lazy(() => import("../components/checkoff/PrinterLiveStrip"));
const PrinterQueueSuggestionBanner = lazy(
  () => import("../components/checkoff/PrinterQueueSuggestionBanner"),
);
import type { PrinterLiveStripState } from "../components/checkoff/PrinterLiveStrip";
import PrintVerifyPanel, {
  type PrintVerifyQueueState,
} from "../components/checkoff/PrintVerifyPanel";
import UnattributedPrintCard from "../components/checkoff/UnattributedPrintCard";
// Lazy: PrinterSendQueuePanel (heavy printer queue UI)
const PrinterSendQueuePanel = lazy(() => import("../components/export/PrinterSendQueuePanel"));
import SortableProgressPart from "../components/checkoff/SortableProgressPart";
import PhaseProgressView from "../components/checkoff/PhaseProgressView";
import PartPreviewDialog from "../components/parts/PartPreviewDialog";
import PartThumbExpandButton from "../components/parts/PartThumbExpandButton";
import SpoolRemainingBadge from "../components/SpoolRemainingBadge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { SegmentedControl } from "../components/ui/segmented-control";
import { Spinner } from "../components/ui/spinner";
import {
  fetchUnattributedPrints,
  fetchPrinterCheckoffLinks,
  fetchPlanPhaseManifest,
  claimUnattributedPrint,
  fetchPrinterQueueSuggestions,
  type PrinterCheckoffLink,
  type PlanPhaseManifestResponse,
  type PrinterQueueSuggestion,
  type ReviewPart,
  type UnattributedPrint,
} from "../api/engine";
import { useBuildTrackingSettingsQuery } from "../queries/buildTracking";
import { buildSourcesRoute, planRoute, prepareMissingPartsRoute } from "../lib/routes";
import { groupCheckoffParts } from "../lib/checkoffGroups";
import {
  checkoffUnitTotals,
  formatPrintedUnitsLine,
  isProgressRowBusy,
  lastCompletedUnit,
  nextUnitToComplete,
} from "../lib/checkoffProgress";
import {
  computePhaseProgress,
} from "../lib/phaseManifest";
import { deskNextStepLine } from "../lib/deskNextStep";
import {
  getProgressRowsForPlan,
  loadPersistedCheckoffUi,
  savePersistedCheckoffUi,
  withProgressRowsForPlan,
  type CheckoffFilterMode,
  type PersistedProgressRow,
} from "../lib/persistedCheckoffUi";
import { moveItemById } from "../lib/reorderList";
import {
  defaultBagBarLabel,
  mergeVisibleProgressReorder,
  newBagBarId,
  progressRowSortableId,
  reconcileProgressRows,
  type ProgressRowRef,
} from "../lib/progressListOrder";
import { flattenReviewParts } from "../lib/reviewParts";
import { useProfileSelection } from "../context/ProfileContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import { waitForSheetThumbnails } from "../lib/waitForSheetThumbnails";
import {
  clearAuxiliaryError,
  currentAuxiliaryError,
  setAuxiliaryError,
  type AuxiliaryErrors,
} from "../lib/auxiliaryErrors";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
} from "../lib/workflowState";
import PwaInstallBanner from "../components/pwa/PwaInstallBanner";
import { useSyncComplete } from "../lib/useSyncComplete";

function CheckoffSheetRow({
  part,
  busy,
  compact,
  eagerThumbs,
  onToggleUnit,
  onPreview,
}: {
  part: ReviewPart;
  busy: boolean;
  compact: boolean;
  eagerThumbs?: boolean;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onPreview: (part: ReviewPart) => void;
}) {
  const done = part.printed_count >= part.quantity_effective && part.quantity_effective > 0;
  return (
    <tr className={cn("sheet-row", done && "sheet-row-done")}>
      <td className="sheet-cell-part">
        <div className="sheet-part">
          <PartThumbExpandButton
            part={part}
            compact={compact}
            eager={eagerThumbs}
            onExpand={onPreview}
          />
          <div className="sheet-part-meta">
            <span className="sheet-filename" title={part.relative_path || part.filename}>
              {part.filename}
            </span>
            <span className="sheet-part-tags">
              {part.filament_hex && (
                <span className="sheet-swatch" style={{ background: part.filament_hex }} />
              )}
              {part.filament_display && <span>{part.filament_display}</span>}
              <SpoolRemainingBadge part={part} />
              {part.role && <span className="sheet-role">{part.role}</span>}
            </span>
          </div>
        </div>
      </td>
      <td className="sheet-cell-qty sheet-cell-qty-readonly">{part.quantity_effective}</td>
      <td className="sheet-cell-printed">
        <div className="sheet-units">
          {part.print_units.map((unitDone, idx) => (
            <label
              key={idx}
              className={cn("sheet-unit", unitDone && "sheet-unit-done")}
              title={`Unit #${idx + 1}`}
            >
              <input
                type="checkbox"
                checked={unitDone}
                onChange={() => onToggleUnit(part, idx)}
                disabled={busy}
              />
              <span>{idx + 1}</span>
            </label>
          ))}
          <span className={cn("sheet-printed-count", done && "sheet-printed-done")}>
            <span className="sheet-printed-screen">
              {part.printed_count}/{part.quantity_effective}
            </span>
            <span className="sheet-printed-label" aria-hidden>
              {part.printed_count} of {part.quantity_effective}
            </span>
          </span>
        </div>
      </td>
      <td className="sheet-cell-notes">
        <span className="sheet-notes-line" aria-hidden />
      </td>
    </tr>
  );
}

const FILTER_MODES: { mode: CheckoffFilterMode; label: string }[] = [
  { mode: "missing", label: "Remaining" },
  { mode: "done", label: "Done" },
  { mode: "all", label: "All" },
];

export default function CheckoffPage() {
  const navigate = useNavigate();
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
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
  const {
    data: buildTrackingSettings,
    error: buildTrackingError,
  } = useBuildTrackingSettingsQuery(Boolean(health?.ok));
  const assemblyTrackingEnabled = buildTrackingSettings?.assembly_tracking ?? false;

  // Re-fetch when the service worker flushes its offline checkoff queue
  useSyncComplete(useCallback(() => {
    if (selectedProfileId != null) void refresh();
  }, [refresh, selectedProfileId]));
  const persistedUi = useMemo(() => loadPersistedCheckoffUi(), []);
  const [filter, setFilter] = useState<CheckoffFilterMode>(persistedUi.filter);
  const [search, setSearch] = useState("");
  const [compactMode, setCompactMode] = useState(persistedUi.compactMode);
  const [continuousPrintLayout, setContinuousPrintLayout] = useState(
    persistedUi.continuousPrintLayout,
  );
  const [progressRowsByPlanId, setProgressRowsByPlanId] = useState<
    Record<string, PersistedProgressRow[]>
  >(() => {
    const initial: Record<string, PersistedProgressRow[]> = {
      ...persistedUi.progressRowsByPlanId,
    };
    for (const key of Object.keys(persistedUi.partOrderByPlanId)) {
      if (!initial[key]?.length) {
        initial[key] = getProgressRowsForPlan(persistedUi, Number(key));
      }
    }
    for (const key of Object.keys(persistedUi.bagBarsByPlanId)) {
      if (!initial[key]?.length) {
        initial[key] = getProgressRowsForPlan(persistedUi, Number(key));
      }
    }
    return initial;
  });
  const [previewPart, setPreviewPart] = useState<ReviewPart | null>(null);
  const [printPrep, setPrintPrep] = useState(false);
  const [verifyRefreshKey, setVerifyRefreshKey] = useState(0);
  const [liveStrip, setLiveStrip] = useState<PrinterLiveStripState>({
    anyPrinting: false,
    activeIntegrationIds: [],
    idleIntegrationIds: [],
    hostCount: 0,
  });
  const [verifyQueue, setVerifyQueue] = useState<PrintVerifyQueueState>({
    awaitingCount: 0,
    watchingCount: 0,
    primaryHostName: null,
  });
  /** Farm send-queue active count (panel still reports; idle banner removed). */
  const sheetRef = useRef<HTMLElement>(null);
  const [unattributedPrints, setUnattributedPrints] = useState<UnattributedPrint[]>([]);
  const unattributedRequestId = useRef(0);
  const [watchingLinks, setWatchingLinks] = useState<PrinterCheckoffLink[]>([]);
  const [awaitingLinks, setAwaitingLinks] = useState<PrinterCheckoffLink[]>([]);
  const [phaseManifest, setPhaseManifest] = useState<PlanPhaseManifestResponse | null>(null);
  const [queueSuggestions, setQueueSuggestions] = useState<PrinterQueueSuggestion[]>([]);
  const [auxiliaryErrors, setAuxiliaryErrors] = useState<AuxiliaryErrors>({});
  const auxiliaryError = currentAuxiliaryError(auxiliaryErrors);
  const reportAuxiliaryError = useCallback((key: string, message: string) => {
    setAuxiliaryErrors((errors) => setAuxiliaryError(errors, key, message));
  }, []);
  const markAuxiliarySuccess = useCallback((key: string) => {
    setAuxiliaryErrors((errors) => clearAuxiliaryError(errors, key));
  }, []);
  const refreshUnattributedPrints = useCallback(async () => {
    const requestId = ++unattributedRequestId.current;
    try {
      const prints = await fetchUnattributedPrints();
      if (requestId !== unattributedRequestId.current) return;
      setUnattributedPrints(prints);
      markAuxiliarySuccess("printer-activity");
    } catch (e) {
      if (requestId !== unattributedRequestId.current) return;
      reportAuxiliaryError(
        "printer-activity",
        `Could not refresh printer activity: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }, [markAuxiliarySuccess, reportAuxiliaryError]);

  useEffect(() => {
    if (buildTrackingError) {
      reportAuxiliaryError(
        "assembly-tracking",
        `Could not load assembly tracking settings: ${
          buildTrackingError instanceof Error
            ? buildTrackingError.message
            : String(buildTrackingError)
        }`,
      );
    } else if (buildTrackingSettings) {
      markAuxiliarySuccess("assembly-tracking");
    }
  }, [
    buildTrackingError,
    buildTrackingSettings,
    markAuxiliarySuccess,
    reportAuxiliaryError,
  ]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Fetch queue suggestions whenever idle printer set changes.
  useEffect(() => {
    const ids = liveStrip.idleIntegrationIds;
    if (!ids.length) {
      setQueueSuggestions([]);
      markAuxiliarySuccess("printer-suggestions");
      return;
    }
    void fetchPrinterQueueSuggestions({ idle_integration_ids: ids })
      .then(({ suggestions }) => {
        setQueueSuggestions(suggestions);
        markAuxiliarySuccess("printer-suggestions");
      })
      .catch((e) => {
        setQueueSuggestions([]);
        reportAuxiliaryError(
          "printer-suggestions",
          `Could not refresh printer suggestions: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }, [
    liveStrip.idleIntegrationIds,
    markAuxiliarySuccess,
    reportAuxiliaryError,
  ]);

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
    await waitForSheetThumbnails(sheet);
    window.print();
  }, []);

  useEffect(() => {
    if (!health?.ok) return;
    void refreshUnattributedPrints();
  }, [health?.ok, refreshUnattributedPrints]);

  // Load phase manifest whenever the selected plan changes
  useEffect(() => {
    if (!health?.ok || selectedProfileId == null) {
      setPhaseManifest(null);
      return;
    }
    void fetchPlanPhaseManifest(selectedProfileId)
      .then((manifest) => {
        setPhaseManifest(manifest);
        markAuxiliarySuccess("phase-progress");
      })
      .catch((e) => {
        reportAuxiliaryError(
          "phase-progress",
          `Could not load phase progress: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }, [
    health?.ok,
    selectedProfileId,
    markAuxiliarySuccess,
    reportAuxiliaryError,
  ]);

  const refreshWatchingLinks = useCallback(() => {
    if (!health?.ok) return;
    void fetchPrinterCheckoffLinks({
      state: "watching",
      profile_id: selectedProfileId ?? undefined,
    })
      .then((res) => {
        setWatchingLinks(res.links ?? []);
        markAuxiliarySuccess("watching-links");
      })
      .catch((e) =>
        reportAuxiliaryError(
          "watching-links",
          `Could not refresh printer activity: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    void fetchPrinterCheckoffLinks({
      state: "awaiting_verify",
      profile_id: selectedProfileId ?? undefined,
    })
      .then((res) => {
        setAwaitingLinks(res.links ?? []);
        markAuxiliarySuccess("awaiting-links");
      })
      .catch((e) =>
        reportAuxiliaryError(
          "awaiting-links",
          `Could not refresh printer activity: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }, [
    health?.ok,
    selectedProfileId,
    markAuxiliarySuccess,
    reportAuxiliaryError,
  ]);

  useEffect(() => {
    refreshWatchingLinks();
  }, [refreshWatchingLinks]);

  useEffect(() => {
    setVerifyQueue({ awaitingCount: 0, watchingCount: 0, primaryHostName: null });
    setAuxiliaryErrors({});
  }, [selectedProfileId]);

  useEffect(() => {
    let next = loadPersistedCheckoffUi();
    next = {
      ...next,
      filter,
      compactMode,
      continuousPrintLayout,
    };
    for (const [planKey, rows] of Object.entries(progressRowsByPlanId)) {
      const planId = Number(planKey);
      if (!Number.isFinite(planId)) continue;
      next = withProgressRowsForPlan(next, planId, rows);
    }
    savePersistedCheckoffUi(next);
  }, [filter, compactMode, continuousPrintLayout, progressRowsByPlanId]);

  const planName =
    profiles.find((p) => p.id === selectedProfileId)?.name ??
    review?.plan_name ??
    "Checkoff";
  const specialRequest =
    profiles.find((p) => p.id === selectedProfileId)?.special_request ?? null;
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  const includedParts = useMemo(() => {
    if (!review) return [];
    return flattenReviewParts(review.part_groups).filter((p) => p.included);
  }, [review]);

  const printingPartIds = useMemo(() => {
    const map = new Map<number, string>(); // part_id → host_name
    for (const link of watchingLinks) {
      if (link.state === "watching") {
        for (const unit of link.units ?? []) {
          if (!map.has(unit.part_id)) {
            map.set(unit.part_id, link.host_name);
          }
        }
      }
    }
    return map;
  }, [watchingLinks]);

  const awaitingPartIds = useMemo(() => {
    const map = new Map<number, string>(); // part_id → host_name
    for (const link of awaitingLinks) {
      if (link.state === "awaiting_verify") {
        for (const unit of link.units ?? []) {
          if (!map.has(unit.part_id)) {
            map.set(unit.part_id, link.host_name);
          }
        }
      }
    }
    return map;
  }, [awaitingLinks]);

  /** Map part_id → suggested printer info from unattributed print candidates. */
  const suggestedPartIds = useMemo(() => {
    const map = new Map<number, { hostName: string; printId: string; filename: string }>();
    for (const print of unattributedPrints) {
      for (const candidate of print.candidates ?? []) {
        for (const matchingFilename of candidate.matching_filenames ?? []) {
          for (const part of includedParts) {
            if (part.filename === matchingFilename && !map.has(part.id)) {
              map.set(part.id, {
                hostName: print.host_name,
                printId: print.id,
                filename: print.filename,
              });
            }
          }
        }
      }
    }
    return map;
  }, [unattributedPrints, includedParts]);

  const partsById = useMemo(() => {
    const map = new Map<number, ReviewPart>();
    for (const p of includedParts) map.set(p.id, p);
    return map;
  }, [includedParts]);

  const planProgressRows = useMemo(() => {
    const preferred: ProgressRowRef[] =
      selectedProfileId == null
        ? []
        : (progressRowsByPlanId[String(selectedProfileId)] ?? []);
    const bags = preferred
      .filter((r): r is Extract<ProgressRowRef, { kind: "bag" }> => r.kind === "bag")
      .map((r) => ({ id: r.id, label: r.label }));
    return reconcileProgressRows(
      preferred,
      includedParts.map((p) => p.id),
      bags,
    );
  }, [includedParts, progressRowsByPlanId, selectedProfileId]);

  const filteredParts = useMemo(() => {
    let rows = includedParts;
    if (filter === "missing") rows = rows.filter((p) => p.missing);
    if (filter === "done") rows = rows.filter((p) => !p.missing);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (p) =>
          p.filename.toLowerCase().includes(q) ||
          p.relative_path.toLowerCase().includes(q) ||
          (p.filament_display || "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [includedParts, filter, search]);

  /** Visible Progress rows: bags always show; parts respect Remaining/Done/search. */
  const filteredRows = useMemo(() => {
    const visibleParts = new Set(filteredParts.map((p) => p.id));
    const searching = search.trim().length > 0;
    return planProgressRows.filter((row) => {
      if (row.kind === "part") return visibleParts.has(row.id);
      if (searching) {
        return row.label.toLowerCase().includes(search.trim().toLowerCase());
      }
      return true;
    });
  }, [filteredParts, planProgressRows, search]);

  /** Ordered parts for print sheet / totals helpers. */
  const filtered = useMemo(() => {
    const out: ReviewPart[] = [];
    for (const row of filteredRows) {
      if (row.kind !== "part") continue;
      const part = partsById.get(row.id);
      if (part) out.push(part);
    }
    return out;
  }, [filteredRows, partsById]);

  const setPlanProgressRows = useCallback(
    (rows: ProgressRowRef[]) => {
      if (selectedProfileId == null) return;
      setProgressRowsByPlanId((prev) => ({
        ...prev,
        [String(selectedProfileId)]: rows,
      }));
    },
    [selectedProfileId],
  );

  const onProgressDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (selectedProfileId == null) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const visibleBefore = filteredRows;
      const visibleIds = visibleBefore.map(progressRowSortableId);
      const movedIds = moveItemById(visibleIds, String(active.id), String(over.id));
      if (movedIds === visibleIds) return;
      const byId = new Map(visibleBefore.map((r) => [progressRowSortableId(r), r]));
      const visibleAfter = movedIds
        .map((id) => byId.get(id))
        .filter((r): r is ProgressRowRef => r != null);
      const nextOrder = mergeVisibleProgressReorder(
        planProgressRows,
        visibleBefore,
        visibleAfter,
      );
      setPlanProgressRows(nextOrder);
    },
    [filteredRows, planProgressRows, selectedProfileId, setPlanProgressRows],
  );

  const onAddBagBar = useCallback(() => {
    if (selectedProfileId == null) return;
    const bags = planProgressRows.filter((r) => r.kind === "bag");
    setPlanProgressRows([
      ...planProgressRows,
      { kind: "bag", id: newBagBarId(), label: defaultBagBarLabel(bags.length) },
    ]);
  }, [planProgressRows, selectedProfileId, setPlanProgressRows]);

  const onBagLabelChange = useCallback(
    (bagId: string, label: string) => {
      setPlanProgressRows(
        planProgressRows.map((row) =>
          row.kind === "bag" && row.id === bagId ? { ...row, label } : row,
        ),
      );
    },
    [planProgressRows, setPlanProgressRows],
  );

  const onRemoveBagBar = useCallback(
    (bagId: string) => {
      setPlanProgressRows(planProgressRows.filter((row) => !(row.kind === "bag" && row.id === bagId)));
    },
    [planProgressRows, setPlanProgressRows],
  );

  const grouped = useMemo(() => groupCheckoffParts(filtered), [filtered]);
  const phaseProgress = useMemo(() => {
    if (!phaseManifest?.has_phases || phaseManifest.phases.length === 0) return null;
    return computePhaseProgress(
      {
        profile_id: phaseManifest.profile_id,
        has_phases: phaseManifest.has_phases,
        phases: phaseManifest.phases,
      },
      includedParts,
    );
  }, [phaseManifest, includedParts]);
  const totals = useMemo(() => checkoffUnitTotals(includedParts), [includedParts]);
  const printedLine = useMemo(() => formatPrintedUnitsLine(includedParts), [includedParts]);
  const toggleBusy = busyPartId != null;
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
  const profilesBackgroundError = getBackgroundError(
    profilesError,
    profiles.length > 0,
  );
  const reviewBackgroundError = getBackgroundError(workspaceError, review != null);

  const suppressIntegrationIds = useMemo(
    () => new Set(liveStrip.activeIntegrationIds),
    [liveStrip.activeIntegrationIds],
  );

  /** Prefer verify when any finished job awaits; printing only when nothing to confirm. */
  const progressMode: "printing" | "verify" | "idle" =
    verifyQueue.awaitingCount > 0
      ? "verify"
      : liveStrip.anyPrinting || verifyQueue.watchingCount > 0
        ? "printing"
        : "idle";

  const progressEyebrow =
    selectedProfileId != null && includedParts.length > 0
      ? `${planName} · ${includedParts.length} part${includedParts.length === 1 ? "" : "s"}`
      : selectedProfileId != null
        ? planName
        : null;

  /**
   * CoS lock: Progress units are operator-ticked only.
   * PageHeader stays stable — live printing proposal rows carry the printing note.
   * Never auto-tick from live/complete host status; Confirm is the only apply path.
   */
  const progressDescription =
    includedParts.length === 0
      ? "Mark each unit as you finish it on the shop floor."
      : "Verify when a print finishes. Remaining parts stay below.";

  const progressNextStep = deskNextStepLine("progress", {
    remainingUnits: totals.remainingUnits,
  });

  const onToggleUnit = useCallback(
    (part: ReviewPart, unitIndex: number) => {
      const next = !part.print_units[unitIndex];
      void toggleUnit(part.id, unitIndex, next).catch((e) => {
        toast.error("Could not update print progress", {
          description: e instanceof Error ? e.message : String(e),
        });
      });
    },
    [toggleUnit],
  );

  const onToggleAssembled = useCallback(
    (part: ReviewPart, unitIndex: number) => {
      const next = !(part.assembled_units?.[unitIndex] ?? false);
      void toggleAssembled(part.id, unitIndex, next).catch((e) => {
        toast.error("Could not update assembly progress", {
          description: e instanceof Error ? e.message : String(e),
        });
      });
    },
    [toggleAssembled],
  );

  const onIncrement = useCallback(
    (part: ReviewPart) => {
      const idx = nextUnitToComplete(part.print_units);
      if (idx >= 0) {
        void toggleUnit(part.id, idx, true).catch((e) => {
          toast.error("Could not update print progress", {
            description: e instanceof Error ? e.message : String(e),
          });
        });
      }
    },
    [toggleUnit],
  );

  const onDecrement = useCallback(
    (part: ReviewPart) => {
      const idx = lastCompletedUnit(part.print_units);
      if (idx >= 0) {
        void toggleUnit(part.id, idx, false).catch((e) => {
          toast.error("Could not update print progress", {
            description: e instanceof Error ? e.message : String(e),
          });
        });
      }
    },
    [toggleUnit],
  );

  const renderEmpty = () => {
    if (selectedProfileId == null) {
      return (
        <EmptyState
          icon={ClipboardCheck}
          title="No Build selected"
          description="Pick a Build to track remaining print work."
          action={{
            label: "Open Plan",
            onClick: () => navigate(planRoute(null)),
          }}
        />
      );
    }
    if (!review || includedParts.length === 0) {
      return (
        <EmptyState
          icon={ClipboardCheck}
          title="No parts yet"
          description="Pick a Build, then track remaining on Checkoff."
          action={{
            label: "Open Plan",
            onClick: () => navigate(planRoute(selectedProfileId)),
          }}
        />
      );
    }
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No parts match"
        description="Try a different filter or clear your search."
        action={{
          label: "Show all",
          onClick: () => {
            setFilter("all");
            setSearch("");
          },
        }}
      />
    );
  };

  if (
    engineState !== "ready" ||
    profilesState !== "ready" ||
    selectedProfileId == null ||
    reviewState !== "ready"
  ) {
    let stateContent;
    if (engineState !== "ready") {
      stateContent = (
        <Card className="no-print">
          <CardContent className="pt-6">
            <p
              className="text-sm text-muted-foreground"
              role={engineState === "loading" ? "status" : undefined}
              aria-live={engineState === "loading" ? "polite" : undefined}
              aria-atomic={engineState === "loading" ? "true" : undefined}
            >
              {engineState === "offline"
                ? "Engine offline. Start the print-partner engine to use Checkoff."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      );
    } else if (profilesState === "error") {
      stateContent = (
        <Card className="no-print border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive" role="alert">
              Could not load plans: {profilesError}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void reloadProfiles()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      );
    } else if (profilesState === "loading" || reviewState === "loading") {
      stateContent = (
        <Card className="no-print border-border shadow-sm">
          <CardContent
            className="flex items-center gap-2 pt-6"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <Spinner className="size-4" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Loading progress…</p>
          </CardContent>
        </Card>
      );
    } else if (reviewState === "error") {
      stateContent = (
        <Card className="no-print border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive" role="alert">
              Could not load Checkoff: {workspaceError}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (selectedProfileId != null) void refresh();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      );
    } else {
      stateContent = <div className="no-print">{renderEmpty()}</div>;
    }

    return (
      <div className="space-y-4">
        <RouteBreadcrumbs
          items={[
            { label: "Sources", to: buildSourcesRoute(selectedProfileId) },
            { label: "Plan", to: planRoute(selectedProfileId) },
            { label: "Checkoff" },
          ]}
        />
        <PageHeader
          icon={CheckSquare}
          accent
          eyebrow={progressEyebrow}
          title="Checkoff"
          description={progressDescription}
        />
        {stateContent}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="no-print space-y-4">
        <RouteBreadcrumbs
          items={[
            { label: "Sources", to: buildSourcesRoute(selectedProfileId) },
            { label: "Plan", to: planRoute(selectedProfileId) },
            { label: "Checkoff" },
          ]}
        />
        <PageHeader
          icon={CheckSquare}
          accent
          eyebrow={progressEyebrow}
          title="Checkoff"
          description={progressDescription}
          actions={
            <PageHeaderActions>
              <Button
                variant="ghost"
                className="min-h-10 w-full sm:w-auto"
                onClick={() => void onPrint()}
                disabled={selectedProfileId == null || filtered.length === 0}
              >
                <Printer className="mr-1 h-4 w-4" />
                Print sheet
              </Button>
              <Button className="min-h-10 w-full sm:w-auto" asChild>
                <Link to={prepareMissingPartsRoute(selectedProfileId)}>Production</Link>
              </Button>
            </PageHeaderActions>
          }
        />

        <DeskNextStep className="no-print">{progressNextStep}</DeskNextStep>

        <PwaInstallBanner />

        <PlanSpecialRequestLine note={specialRequest} />

        {selectedProfile && (
          <PlanFreshnessNotice
            freshness={selectedProfile.freshness}
            action={{ kind: "review", href: buildSourcesRoute(selectedProfileId) }}
          />
        )}

        {includedParts.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-xs">
              <span
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={totals.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${totals.percent}% of print units completed`}
              >
                <span
                  className="block h-full rounded-full bg-success transition-[width]"
                  style={{ width: `${totals.percent}%` }}
                />
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {totals.percent}% · {totals.remainingUnits} remaining
              </span>
            </div>
            {isMobileLayout && (
              <span className="ml-auto font-mono text-sm tabular-nums text-muted-foreground">
                {totals.printedUnits} / {totals.totalUnits}
              </span>
            )}
          </div>
        )}

        <div className="checkoff-sticky flex flex-col gap-2">
          <Suspense fallback={null}>
            <PrinterLiveStrip
              engineReady={Boolean(health?.ok)}
              onLiveStateChange={setLiveStrip}
              onCheckoffUpdate={(profileId) => {
                if (selectedProfileId != null && profileId === selectedProfileId) {
                  setVerifyRefreshKey((k) => k + 1);
                }
                refreshWatchingLinks();
              }}
              onUnattributedUpdate={() => {
                void refreshUnattributedPrints();
              }}
            />
          </Suspense>
          {unattributedPrints.length > 0 && (
            <div className="flex flex-col gap-2">
              {unattributedPrints.map((print) => (
                <UnattributedPrintCard
                  key={print.id}
                  print={print}
                  onClaimed={() => {
                    void refreshUnattributedPrints();
                    setVerifyRefreshKey((k) => k + 1);
                  }}
                  onDismissed={() => void refreshUnattributedPrints()}
                />
              ))}
            </div>
          )}
          {queueSuggestions.length > 0 && (
            <Suspense fallback={null}>
              <PrinterQueueSuggestionBanner
                suggestions={queueSuggestions}
                onDrained={(printerId) =>
                  setQueueSuggestions((current) =>
                    printerId === undefined
                      ? []
                      : current.filter(
                          (suggestion) => suggestion.printer_id !== printerId,
                        ),
                  )
                }
                onDismiss={() => setQueueSuggestions([])}
              />
            </Suspense>
          )}
          <PrintVerifyPanel
            engineReady={Boolean(health?.ok)}
            profileId={selectedProfileId}
            parts={includedParts}
            refreshKey={verifyRefreshKey}
            suppressIntegrationIds={suppressIntegrationIds}
            onQueueChange={setVerifyQueue}
            onVerified={() => {
              if (selectedProfileId != null) void refresh();
            }}
          />
          <Suspense fallback={null}>
            <PrinterSendQueuePanel
              engineReady={Boolean(health?.ok)}
              emphasizeSendReady={progressMode === "idle"}
            />
          </Suspense>
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <input
            type="search"
            aria-label="Search progress parts"
            className="checkoff-search w-full min-w-0 rounded-md border border-input bg-background px-3 py-2.5 text-base sm:flex-1 sm:py-1.5 sm:text-sm"
            placeholder="Search parts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={toggleBusy}
          />
          <div
            className={cn(
              isMobileLayout ? "w-full" : "shrink-0",
            )}
          >
            <SegmentedControl
              aria-label="Filter"
              className={cn(isMobileLayout ? "w-full" : undefined)}
              value={filter}
              onValueChange={(value) => setFilter(value)}
              options={FILTER_MODES.map(({ mode, label }) => ({
                value: mode,
                label,
              }))}
            />
          </div>
          {!isMobileLayout && (
            <>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={compactMode}
                  onChange={(e) => setCompactMode(e.target.checked)}
                />
                Compact print rows
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={continuousPrintLayout}
                  onChange={(e) => setContinuousPrintLayout(e.target.checked)}
                />
                Continuous layout when printing
              </label>
            </>
          )}
          </div>
        </div>

        <div>
          {profilesBackgroundError && (
            <p className="text-sm text-destructive" role="alert">
              Could not refresh plans: {profilesBackgroundError}
            </p>
          )}
          {reviewBackgroundError && (
            <p className="text-sm text-destructive" role="alert">
              Could not refresh Checkoff: {reviewBackgroundError}
            </p>
          )}
          {auxiliaryError && (
            <p className="text-sm text-destructive" role="alert">
              {auxiliaryError}
            </p>
          )}
        </div>
      </div>

      <div className="no-print">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mb-2 h-9 px-3"
          disabled={toggleBusy}
          onClick={onAddBagBar}
        >
          Add bag/sort
        </Button>
      </div>

      {phaseProgress ? (
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
          ) : filteredRows.length === 0 ? (
            <div className="no-print">{renderEmpty()}</div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onProgressDragEnd}
            >
              <SortableContext
                items={filteredRows.map(progressRowSortableId)}
                strategy={verticalListSortingStrategy}
              >
                <div
                  className="no-print flex flex-col gap-2 sm:gap-2"
                  aria-label="Reorderable progress parts"
                >
                  {filteredRows.map((row) => {
                    if (row.kind === "bag") {
                      return (
                        <SortableProgressPart
                          key={progressRowSortableId(row)}
                          kind="bag"
                          bagId={row.id}
                          label={row.label}
                          mobile={isMobileLayout}
                          busy={toggleBusy}
                          disabled={toggleBusy}
                          onLabelChange={(label) => onBagLabelChange(row.id, label)}
                          onRemove={() => onRemoveBagBar(row.id)}
                        />
                      );
                    }
                    const part = partsById.get(row.id);
                    if (!part) return null;
                    return (
                      <SortableProgressPart
                        key={progressRowSortableId(row)}
                        kind="part"
                        part={part}
                        mobile={isMobileLayout}
                        busy={isProgressRowBusy(busyPartId, part.id)}
                        disabled={toggleBusy}
                        printingOn={printingPartIds.get(part.id)}
                        awaitingVerify={awaitingPartIds.get(part.id)}
                        suggestedPrinter={suggestedPartIds.get(part.id)}
                        assemblyTrackingEnabled={assemblyTrackingEnabled}
                        onToggleUnit={onToggleUnit}
                        onIncrement={onIncrement}
                        onDecrement={onDecrement}
                        onPreview={setPreviewPart}
                        onToggleAssembled={onToggleAssembled}
                        onClaim={(printId) => {
                          if (selectedProfileId == null) return;
                          void claimUnattributedPrint(printId, selectedProfileId)
                            .then(() => {
                              markAuxiliarySuccess("claim-printer-activity");
                              void refreshUnattributedPrints();
                              refreshWatchingLinks();
                            })
                            .catch((e) =>
                              reportAuxiliaryError(
                                "claim-printer-activity",
                                `Could not claim printer activity: ${e instanceof Error ? e.message : String(e)}`,
                              ),
                            );
                        }}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {/* Printable sheet — paper tokens; print-only on Progress (GRE-233). Label: Print sheet. */}
          {filtered.length > 0 ? (
            <article
              ref={sheetRef}
              aria-hidden={!printPrep}
              className={cn(
                "checkoff-sheet checkoff-sheet-print-only",
                compactMode && "compact",
                continuousPrintLayout && "checkoff-sheet-print-continuous",
                printPrep && "is-print-prep",
                printPrep
                  ? "pointer-events-none fixed top-0 left-0 -z-10 w-[880px] opacity-0 print:pointer-events-auto print:relative print:z-auto print:w-auto print:opacity-100"
                  : null,
              )}
            >
              <header className="sheet-header">
                <h2 className="sheet-title">{planName}</h2>
                <p className="sheet-subtitle">
                  {filtered.length} part{filtered.length === 1 ? "" : "s"} · {printedLine}
                </p>
              </header>

              {grouped.map((repo) => (
                <section key={repo.repoLayer} className="sheet-repo">
                  <h3 className="sheet-repo-title">
                    {repo.repoLabel}
                    <span className="sheet-repo-count">{repo.partCount}</span>
                  </h3>
                  {repo.folders.map((group) => (
                    <div key={group.folder} className="sheet-folder">
                      <h4 className="sheet-folder-title">{group.folder}</h4>
                      <div className="sheet-table-wrap">
                        <table className="sheet-table">
                          <thead>
                            <tr>
                              <th className="sheet-cell-part">Part</th>
                              <th className="sheet-cell-qty">Qty</th>
                              <th className="sheet-cell-printed">Printed</th>
                              <th className="sheet-cell-notes">Notes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.parts.map((part) => (
                              <CheckoffSheetRow
                                key={part.id}
                                part={part}
                                busy={busyPartId === part.id || toggleBusy}
                                compact={compactMode}
                                eagerThumbs={printPrep}
                                onToggleUnit={onToggleUnit}
                                onPreview={setPreviewPart}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </article>
          ) : null}

      {review && (
        <div className="no-print flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button className="min-h-10 w-full sm:w-auto" variant="ghost" asChild>
            <Link to={planRoute(selectedProfileId)}>Back to Plan</Link>
          </Button>
          <Button className="min-h-10 w-full sm:w-auto" variant="ghost" asChild>
            <Link to={prepareMissingPartsRoute(selectedProfileId)}>Prepare missing parts</Link>
          </Button>
        </div>
      )}

      <PartPreviewDialog part={previewPart} onClose={() => setPreviewPart(null)} />
    </div>
  );
}

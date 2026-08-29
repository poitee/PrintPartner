import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ProductionRoute } from "@print-partner/contracts";
import { FileArchive } from "lucide-react";
import BuildSummaryHeader from "../components/build/BuildSummaryHeader";
import PageHeader from "../components/layout/PageHeader";
import PageShell from "../components/layout/PageShell";
import TaskList, { type WorkflowTask } from "../components/layout/TaskList";
import ExportActionCards from "../components/export/ExportActionCards";
import ExportRecentPanel from "../components/export/ExportRecentPanel";
import PartsManifestTransfer from "../components/export/PartsManifestTransfer";
import ProductionSelectionPanel from "../components/export/ProductionSelectionPanel";
import ProductionRulesPanel from "../components/export/ProductionRulesPanel";
import ProductionRouteChangeDialog from "../components/export/ProductionRouteChangeDialog";
import ProductionRouteQuestion from "../components/export/ProductionRouteQuestion";
import StlRoutePanel from "../components/export/StlRoutePanel";
import ExternalPrintRoutePanel from "../components/export/ExternalPrintRoutePanel";
import SlicerLinksPanel from "../components/export/SlicerLinksPanel";
import SlicerHandoffPanel from "../components/export/SlicerHandoffPanel";
import WorkPackageCard from "../components/export/WorkPackageCard";
import { useProductionCheckoffLinks } from "../components/export/useProductionCheckoffLinks";
import { useProductionSendFleet } from "../components/export/useProductionSendFleet";
import AcceptedPlateSection from "../components/export/accepted-plates/AcceptedPlateSection";
// Lazy: PrinterSendPanel pulls in heavy printer integration + dnd-kit
const PrinterSendPanel = lazy(() => import("../components/export/PrinterSendPanel"));
const PrinterSendQueuePanel = lazy(() => import("../components/export/PrinterSendQueuePanel"));
import ShareBuildExportDialog from "../components/share/ShareBuildExportDialog";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useProductionSelection } from "../hooks/useProductionSelection";
import { useProductionSetup } from "../queries/productionSetup";
import { useSourcesQuery } from "../queries/sources";
import { useRoleFilamentsQuery } from "../queries/roleFilaments";
import {
  useAcceptedPlateExportJobsQuery,
  useAcceptedPlateWorkspaceQuery,
} from "../queries/acceptedPlates";
import { flattenReviewParts } from "../lib/reviewParts";
import { planRoute, progressRoute, settingsPrintersRoute } from "../lib/routes";
import {
  clearProductionSelectionGroup,
  productionSelectableUnits,
  selectedProductionTokens,
  toggleProductionUnit,
} from "../lib/productionSelection";
import {
  productionRouteChange,
  projectWorkPackages,
  type ProductionRouteChange,
} from "../lib/workPackageProjection";
import {
  firstUnfinishedProductionTask,
  PRODUCTION_ROUTE_LABEL,
  PRODUCTION_TASK_IDS,
  PRODUCTION_TASK_ROUTE,
  productionStageAlias,
  productionTaskFromParam,
  productionTasks,
  type ProductionTaskId,
} from "../lib/workPackageTasks";
import { cn } from "@/lib/utils";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
  shouldMountPlanTools,
} from "../lib/workflowState";

type OperationFailure = Readonly<{ message: string; retry: () => void }>;

/**
 * The line under the task list heading. It never counts steps, because the
 * number of steps depends on the route the operator picked.
 */
const TASK_LIST_DESCRIPTION: Readonly<Record<ProductionRoute, string>> = {
  plates:
    "Plate preparation stays together. Production reopens at the first unfinished task.",
  stl: "Production reopens at the first unfinished task.",
  external:
    "All three steps happen in one panel. Production reopens at the first unfinished task.",
};

/**
 * Production — the Build's work packages.
 *
 * The page asks one question before it shows any task list: how do you want to
 * make these units? Making Plates for linked printers, taking the unit files,
 * and recording a print that already happened elsewhere are not three lengths
 * of one flow. They differ in what they produce and whether a printer is
 * involved at all, so each route owns its own task list and the tasks of the
 * other two are absent rather than greyed out.
 *
 * Inside a route the tasks are resumable, not a numbered pass. The real job
 * leaves the product: export, slice somewhere else, come back later with
 * G-code, send it, wait, then verify in Checkoff. Statuses come from real
 * records (production setup, Plate revision, export jobs, printer checkoff
 * links), not from a `?stage=` URL parameter. There is no step count anywhere,
 * because the number of steps now depends on the answer.
 *
 * The old `?stage=` and `?select=` links still work as aliases, and they land
 * on the Plates route where they were written.
 */
export default function ExportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const {
    selectedProfileId,
    profiles,
    loading: profilesLoading,
    error: profilesError,
    reloadProfiles,
  } = useProfileSelection();
  const { review, refresh, loading, error: planError } = usePlanWorkspace();
  const { data: sources = [] } = useSourcesQuery();
  const [shareOpen, setShareOpen] = useState(false);
  const [slicedFile, setSlicedFile] = useState<Readonly<{ name: string }> | null>(null);
  const [assignFailure, setAssignFailure] = useState<OperationFailure | null>(null);
  const [plateFailure, setPlateFailure] = useState<OperationFailure | null>(null);
  const [exportFailure, setExportFailure] = useState<OperationFailure | null>(null);
  const [sendFailure, setSendFailure] = useState<OperationFailure | null>(null);
  /**
   * The route answer is durable Build state, so these three hold only what the
   * operator is doing right now: reopening the question to change the answer,
   * a lossy change waiting for confirmation, and a save that failed.
   */
  const [changingRoute, setChangingRoute] = useState(false);
  const [pendingRouteChange, setPendingRouteChange] = useState<ProductionRouteChange | null>(null);
  const [routeFailure, setRouteFailure] = useState<OperationFailure | null>(null);
  const roleFilamentsQuery = useRoleFilamentsQuery(
    selectedProfileId,
    Boolean(health?.ok),
  );
  const roleFilaments = roleFilamentsQuery.data ?? [];
  const roleFilamentError = roleFilamentsQuery.error
    ? `Could not refresh filament assignments: ${
        roleFilamentsQuery.error instanceof Error
          ? roleFilamentsQuery.error.message
          : String(roleFilamentsQuery.error)
      }`
    : null;
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
  const profilesBackgroundError = getBackgroundError(
    profilesError,
    profiles.length > 0,
  );
  const planToolsReady = shouldMountPlanTools(engineState, selectedProfileId);

  const planName =
    selectedProfileId != null
      ? profiles.find((p) => p.id === selectedProfileId)?.name
      : null;

  const includedParts = useMemo(() => {
    if (!review) return [];
    return flattenReviewParts(review.part_groups).filter((p) => p.included);
  }, [review]);
  const remainingParts = useMemo(
    () => includedParts.filter((p) => p.missing),
    [includedParts],
  );
  const workspaceQuery = useAcceptedPlateWorkspaceQuery(
    selectedProfileId,
    selectedProfileId != null && engineState === "ready",
  );
  const exportJobsQuery = useAcceptedPlateExportJobsQuery(
    selectedProfileId,
    selectedProfileId != null && engineState === "ready",
  );
  const checkoffLinksQuery = useProductionCheckoffLinks(
    selectedProfileId,
    engineState === "ready",
  );
  const sendFleetQuery = useProductionSendFleet(engineState === "ready");
  const selectableUnits = useMemo(
    () => productionSelectableUnits(workspaceQuery.data ?? { kind: "empty_plan" }),
    [workspaceQuery.data],
  );
  const selectParam = searchParams.get("select");
  const { selection, setSelection, setupSaving, setupError } = useProductionSelection(
    selectableUnits,
    selectParam,
    selectedProfileId,
  );
  const selectedTokens = selectedProductionTokens(selectableUnits, selection);
  const productionSetup = useProductionSetup(selectedProfileId, engineState === "ready");
  const setup = productionSetup.data;
  /** Null until the operator answers the question. There is no default route. */
  const route = setup?.route ?? null;

  const projection = useMemo(
    () =>
      projectWorkPackages({
        profileId: selectedProfileId,
        workspace: workspaceQuery.data,
        setup,
        selectedTokens,
        exportRecords: exportJobsQuery.data ?? [],
        checkoffLinks: checkoffLinksQuery.data ?? [],
        slicedFile,
        printer: null,
        exportFailed: exportFailure != null,
      }),
    [
      checkoffLinksQuery.data,
      exportFailure,
      exportJobsQuery.data,
      selectedProfileId,
      selectedTokens,
      setup,
      slicedFile,
      workspaceQuery.data,
    ],
  );

  const workspace = workspaceQuery.data;
  const printerCount =
    workspace && workspace.kind !== "empty_plan" ? workspace.printers.length : 0;
  const printerAssignmentStatus = printerCount === 0
    ? "Printer required"
    : workspace?.kind === "ready" && workspace.unassigned.length === 0
      ? "Assigned"
      : "Choose printers";
  const plateLayoutStatus = workspace?.kind === "ready"
    ? `Revision ${workspace.plate_revision_number}`
    : "Assign printers first";
  const tasks = useMemo(() => {
    const bench = projection.bench;
    if (!bench || route == null) return [];
    switch (route) {
      case "plates":
        return productionTasks({
          route,
          pkg: bench,
          workspace,
          selectedCount: selectedTokens.length,
          totalUnitCount: selectableUnits.length,
          printerCount,
          sendPrinterCount: sendFleetQuery.data?.sendCount ?? 0,
          dispatchedFilenames: [...projection.active, ...projection.recent].map(
            (entry) => entry.title,
          ),
          exportError: exportFailure?.message ?? null,
          sendError: sendFailure?.message ?? null,
          plateError: plateFailure?.message ?? null,
          assignError: assignFailure?.message ?? null,
        });
      case "stl":
        return productionTasks({
          route,
          pkg: bench,
          selectedCount: selectedTokens.length,
          totalUnitCount: selectableUnits.length,
        });
      case "external":
        return productionTasks({
          route,
          pkg: bench,
          recordedPrintCount: projection.active.length + projection.recent.length,
        });
      default: {
        const _exhaustive: never = route;
        return _exhaustive;
      }
    }
  }, [
    assignFailure,
    exportFailure,
    plateFailure,
    printerCount,
    projection,
    route,
    selectableUnits.length,
    selectedTokens.length,
    sendFailure,
    sendFleetQuery.data,
    workspace,
  ]);

  /**
   * Resume point. With no task in the URL the page opens the first unfinished
   * task, so a reload or a move to another device lands where the work stopped.
   * An explicit `?task=` or legacy `?stage=` still wins, so old links work and
   * the user can jump to any available task. A link naming a task from another
   * route is ignored, because that task does not exist here.
   */
  const paramTask = productionTaskFromParam(
    searchParams.get("task") ?? searchParams.get("stage"),
  );
  const requestedTask =
    paramTask != null && route != null && PRODUCTION_TASK_ROUTE[paramTask] === route
      ? paramTask
      : null;
  const resumeTask =
    route != null && tasks.length > 0 ? firstUnfinishedProductionTask({ tasks, route }) : null;
  /**
   * An old link may point at a task that is genuinely blocked now. The link
   * still works, but it opens the resume task and says what is missing rather
   * than pretending the blocked task is available.
   */
  const blockedRequest = requestedTask
    ? tasks.find((task) => task.id === requestedTask && task.state === "blocked")
    : undefined;
  const activeTaskId: ProductionTaskId | null =
    requestedTask && !blockedRequest ? requestedTask : resumeTask;
  const activeTask = tasks.find((task) => task.id === activeTaskId);

  const openTask = (taskId: ProductionTaskId) => {
    const params = new URLSearchParams(searchParams);
    params.set("task", taskId);
    const stage = productionStageAlias(taskId);
    if (stage) {
      params.set("stage", stage);
    } else {
      params.delete("stage");
    }
    setSearchParams(params, { replace: true });
  };

  const resumeHere = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("task");
    params.delete("stage");
    setSearchParams(params, { replace: true });
  };

  /**
   * The answer is durable, so it goes straight to the production setup. The
   * patch names only `route`, which is how the Required-unit selection survives
   * a switch: nothing else in the record is touched, and SC 3.3.7 Redundant
   * Entry is satisfied without asking the operator to choose units again.
   *
   * A failed save keeps the answer on screen with an inline Retry rather than a
   * toast, so the problem cannot scroll away or time out.
   */
  const saveRoute = (next: ProductionRoute) => {
    setRouteFailure(null);
    void productionSetup
      .save({ route: next })
      .then(() => {
        setPendingRouteChange(null);
        setChangingRoute(false);
      })
      .catch((error: unknown) => {
        setRouteFailure({
          message: `Could not save how you want to make these units: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: () => saveRoute(next),
        });
      });
  };

  /**
   * A switch that leaves no work behind happens at once. A switch that steps
   * away from Plate work says what it steps away from, and waits for an
   * explicit action. Nothing is deleted either way, so the operator can always
   * come back.
   */
  const requestRoute = (next: ProductionRoute) => {
    if (next === route) {
      setChangingRoute(false);
      return;
    }
    if (route == null || projection.bench == null) {
      saveRoute(next);
      return;
    }
    const change = productionRouteChange({
      pkg: projection.bench,
      from: route,
      to: next,
      printerAssignments: setup?.printer_assignments ?? [],
    });
    if (!change.confirm) {
      saveRoute(next);
      return;
    }
    setPendingRouteChange(change);
  };

  const taskFailure = (taskId: ProductionTaskId): OperationFailure | null => {
    if (taskId === "prepare-plates") return assignFailure ?? plateFailure;
    if (taskId === "export-for-slicing") return exportFailure;
    if (taskId === "send-or-start") return sendFailure;
    return null;
  };

  const taskRows: WorkflowTask[] = tasks.map((task) => {
    const failure = taskFailure(task.id);
    return {
      id: task.id,
      label: task.label,
      hint: task.hint,
      state: task.state,
      statusLabel:
        task.id === activeTaskId && task.state !== "complete" && task.state !== "blocked"
          ? `${task.statusLabel} · open`
          : task.statusLabel,
      disabledReason: task.disabledReason ?? undefined,
      onAction: task.state === "blocked" ? undefined : () => openTask(task.id),
      actionLabel:
        task.id === activeTaskId
          ? "Open below"
          : task.id === "prepare-plates"
            ? task.state === "complete" ? "Review Plates" : "Prepare Plates"
            : task.state === "complete" ? "Review" : task.label,
      error: failure
        ? {
            message: failure.message,
            onRetry: () => {
              const retry = failure.retry;
              openTask(task.id);
              retry();
            },
          }
        : undefined,
    };
  });

  const planIdentity =
    planName && includedParts.length > 0
      ? `${planName} · ${includedParts.length} part${includedParts.length === 1 ? "" : "s"}`
      : planName;

  /**
   * Choosing Required units is the same question on the Plates route and the
   * unit-files route, so both open this one section rather than two that could
   * drift apart.
   */
  const unitSelectionSection = (
    <section
      id="plate-builder-units"
      className="scroll-mt-4 space-y-3 rounded-lg border border-border bg-card p-4"
      aria-labelledby="production-choose-units-heading"
    >
      <div className="space-y-1">
        <h4 id="production-choose-units-heading" className="text-sm font-semibold">
          Choose Required units
        </h4>
        <p className="text-xs text-muted-foreground">
          Completed units stay out unless you choose them again.
        </p>
      </div>
      {setupSaving ? (
        <p className="text-xs text-muted-foreground" role="status">Saving production setup…</p>
      ) : null}
      {setupError ? (
        <p className="text-sm text-destructive" role="alert">
          Production choices could not be saved:{" "}
          {setupError instanceof Error ? setupError.message : String(setupError)}
        </p>
      ) : null}
      {selectableUnits.length > 0 ? (
        <ProductionSelectionPanel
          units={selectableUnits}
          selection={selection}
          onToggle={(token) => setSelection((current) => toggleProductionUnit(current, token))}
          onClearGroup={(field, value) => setSelection((current) =>
            clearProductionSelectionGroup(current, selectableUnits, field, value)
          )}
          onSelectAll={() => setSelection(new Set(selectableUnits.map((unit) => unit.token)))}
          onSelectIncomplete={() => setSelection(new Set(
            selectableUnits.filter((unit) => !unit.completed).map((unit) => unit.token),
          ))}
          onClearAll={() => setSelection(new Set())}
        />
      ) : null}
    </section>
  );

  const preparePlatesPanel = (
    <div className="space-y-4">
      <nav
        aria-label="Plate preparation sections"
        className="grid gap-1 rounded-lg border border-border bg-card p-2 shadow-sm sm:grid-cols-3"
      >
        {[
          { href: "#plate-builder-units", label: "Required units", status: `${selectedTokens.length} selected` },
          { href: "#plate-builder-printers", label: "Printers", status: printerAssignmentStatus },
          { href: "#plate-builder-layout", label: "Plate layout", status: plateLayoutStatus },
        ].map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="flex min-h-14 min-w-0 flex-col justify-center rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            <span className="truncate font-medium text-foreground">{item.label}</span>
            <span className="truncate text-xs text-muted-foreground">{item.status}</span>
          </a>
        ))}
      </nav>
      {unitSelectionSection}

      {selectedProfileId != null ? (
        <>
          <AcceptedPlateSection
            sectionId="plate-builder-printers"
            profileId={selectedProfileId}
            enabled={engineState === "ready"}
            selectedTokens={new Set(selectedTokens)}
            view="assign"
            onFailure={setAssignFailure}
          />
          {printerCount === 0 ? (
            <div className="rounded-lg border border-warning/35 bg-warning-soft p-4 text-sm text-warning">
              No printer is set up.{" "}
              <Link className="font-medium underline underline-offset-2" to={settingsPrintersRoute()}>
                Add a printer in Settings
              </Link>{" "}
              to assign the selected Required units and prepare Plates.
            </div>
          ) : null}

          <details className="rounded-lg border border-border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              Advanced Plate rules
            </summary>
            <div className="border-t border-border p-3">
              <p className="mb-3 text-xs text-muted-foreground">
                Save repeatable grouping, material, or printer rules for this Build. Most work packages only need the bulk assignment controls above.
              </p>
              <ProductionRulesPanel profileId={selectedProfileId} />
            </div>
          </details>

          <AcceptedPlateSection
            sectionId="plate-builder-layout"
            profileId={selectedProfileId}
            enabled={engineState === "ready"}
            selectedTokens={new Set(selectedTokens)}
            view="arrange"
            onFailure={setPlateFailure}
          />
          <SlicerLinksPanel />
        </>
      ) : null}
    </div>
  );

  const exportPanel = (
    <>
      <SlicerHandoffPanel onFailure={setExportFailure} />
      {loading && !review ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading plan…</p>
          </CardContent>
        </Card>
      ) : planError && !review ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive">Could not load this plan: {planError}</p>
            <Button size="sm" variant="secondary" onClick={() => {
              if (selectedProfileId != null) void refresh();
            }}>Retry</Button>
          </CardContent>
        </Card>
      ) : (
        <div className={cn("grid gap-4", "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,18.75rem)]")}>
          <div className="min-w-0">
            <ExportActionCards
              onShare={() => setShareOpen(true)}
              roleFilaments={roleFilaments}
              selectedTokens={selectedTokens}
            />
          </div>
          <ExportRecentPanel />
        </div>
      )}
      <PartsManifestTransfer
        review={review}
        sources={sources}
        onApplied={async () => {
          await Promise.all([refresh(), roleFilamentsQuery.refetch()]);
        }}
      />
    </>
  );

  const sendPanel = (
    <Suspense fallback={<div className="h-32 animate-pulse rounded-lg bg-muted" />}>
      <div className="space-y-3">
        <PrinterSendPanel
          remainingParts={remainingParts}
          profileId={selectedProfileId}
          planName={planName}
          engineReady={engineState === "ready"}
          onSlicedFileChange={setSlicedFile}
          onFailure={setSendFailure}
        />
        <PrinterSendQueuePanel
          engineReady={engineState === "ready"}
          allowDispatch
        />
      </div>
    </Suspense>
  );

  const stlPanel =
    selectedProfileId != null ? (
      <StlRoutePanel
        profileId={selectedProfileId}
        selectedTokens={selectedTokens}
        totalUnitCount={selectableUnits.length}
        onOpenUnitSelection={() => openTask("choose-units")}
      />
    ) : null;

  const externalPanel =
    selectedProfileId != null ? (
      <ExternalPrintRoutePanel
        profileId={selectedProfileId}
        onRecorded={() => {
          void checkoffLinksQuery.refetch();
        }}
      />
    ) : null;

  const panelFor = (taskId: ProductionTaskId) => {
    switch (taskId) {
      case "prepare-plates":
        return preparePlatesPanel;
      case "export-for-slicing":
        return exportPanel;
      case "add-sliced-file":
      case "send-or-start":
        return sendPanel;
      case "choose-units":
        return unitSelectionSection;
      case "download-stl":
        return stlPanel;
      // Picking the file, attributing it and confirming happen together in one
      // panel, so all three rows open it.
      case "pick-print-file":
      case "attribute-units":
      case "confirm-record":
        return externalPanel;
    }
  };

  return (
    <PageShell>
      <PageHeader
        icon={FileArchive}
        accent
        eyebrow={planIdentity ? `Make · ${planIdentity}` : "Make"}
        title="Production"
        description="Decide how this Build's Required units get made, then work through the tasks for that route."
      />
      <BuildSummaryHeader currentStageId="production" />

      {(profilesBackgroundError || roleFilamentError || (planError && review)) && (
        <div className="space-y-1 text-sm text-destructive" role="alert">
          {profilesBackgroundError && (
            <p>Could not refresh plans: {profilesBackgroundError}</p>
          )}
          {roleFilamentError && <p>{roleFilamentError}</p>}
          {planError && review && <p>Could not refresh this plan: {planError}</p>}
        </div>
      )}

      {engineState !== "ready" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Engine offline — start the print-partner engine to export."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      ) : profilesState === "error" ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive">
              Could not load plans: {profilesError}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void reloadProfiles()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : profilesState === "loading" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading plans…</p>
          </CardContent>
        </Card>
      ) : !planToolsReady ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Open a plan to send sliced files or export slicer input.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {projection.active.length > 0 ? (
            <section className="space-y-2" aria-labelledby="production-active-heading">
              <h2 id="production-active-heading" className="text-sm font-semibold">
                Work packages at a printer
              </h2>
              <div className="space-y-2">
                {projection.active.map((entry) => (
                  <WorkPackageCard key={entry.id} pkg={entry} />
                ))}
              </div>
            </section>
          ) : null}

          {projection.bench ? (
            <WorkPackageCard
              pkg={projection.bench}
              actions={
                requestedTask ? (
                  <Button size="sm" variant="ghost" className="min-h-9" onClick={resumeHere}>
                    Resume where I stopped
                  </Button>
                ) : null
              }
            >
              {route == null || changingRoute ? (
                <ProductionRouteQuestion
                  key={route ?? "unanswered"}
                  value={route}
                  saving={productionSetup.saving}
                  error={
                    routeFailure
                      ? { message: routeFailure.message, onRetry: routeFailure.retry }
                      : null
                  }
                  onSubmit={requestRoute}
                  onCancel={
                    route != null
                      ? () => {
                          setChangingRoute(false);
                          setRouteFailure(null);
                        }
                      : undefined
                  }
                />
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <p className="text-sm text-foreground">
                      <span className="text-muted-foreground">Route: </span>
                      <span className="font-medium">{PRODUCTION_ROUTE_LABEL[route]}</span>
                    </p>
                    {projection.routeLocked ? (
                      // A file for this Build is already at a printer, so the
                      // result is physical and belongs to Checkoff. GOV.UK
                      // advises against disabling a control, so this is
                      // read-only text with the route out, not a dead button.
                      <p className="text-xs text-muted-foreground">
                        A file is already at a printer, so the route stays as it is. Track the
                        printed result in{" "}
                        <Link
                          className="font-medium underline underline-offset-2"
                          to={progressRoute(selectedProfileId)}
                        >
                          Checkoff
                        </Link>
                        .
                      </p>
                    ) : (
                      // GOV.UK check answers: a Change link says what it
                      // changes to anyone who cannot see which section it sits
                      // beside.
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto min-h-11 p-0"
                        aria-label="Change how you want to make these units"
                        onClick={() => setChangingRoute(true)}
                      >
                        Change
                      </Button>
                    )}
                  </div>
                  <TaskList
                    title="Prepare this work package"
                    description={TASK_LIST_DESCRIPTION[route]}
                    tasks={taskRows}
                  />
                </>
              )}
              {blockedRequest ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {blockedRequest.label} is not available yet. {blockedRequest.disabledReason}{" "}
                  Opened {activeTask?.label ?? "the next task"} instead.
                </p>
              ) : null}
              {activeTask ? (
                <section className="space-y-3" aria-labelledby="production-open-task-heading">
                  <h3
                    id="production-open-task-heading"
                    className="text-sm font-semibold text-foreground"
                  >
                    {activeTask.label}
                  </h3>
                  {activeTaskId ? panelFor(activeTaskId) : null}
                </section>
              ) : null}
            </WorkPackageCard>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {/* Only the two routes that consume a unit selection get this
                shortcut. Recording a print picks its own units inside the
                panel. */}
            {route === "plates" || route === "stl" ? (
              <Button
                variant="secondary"
                className="min-h-11"
                onClick={() => {
                  setSelection(new Set(
                    selectableUnits.filter((unit) => !unit.completed).map((unit) => unit.token),
                  ));
                  openTask(PRODUCTION_TASK_IDS[route][0]);
                }}
              >
                Prepare more units
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" asChild>
              <Link to={progressRoute(selectedProfileId)}>Open Checkoff</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to={planRoute(selectedProfileId)}>Back to Plan</Link>
            </Button>
          </div>

          {projection.recent.length > 0 ? (
            <section className="space-y-2" aria-labelledby="production-recent-heading">
              <h2 id="production-recent-heading" className="text-sm font-semibold">
                Finished work packages
              </h2>
              <div className="space-y-2">
                {projection.recent.map((entry) => (
                  <WorkPackageCard key={entry.id} pkg={entry} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <ProductionRouteChangeDialog
        change={pendingRouteChange}
        saving={productionSetup.saving}
        error={pendingRouteChange && routeFailure ? routeFailure.message : null}
        onConfirm={() => {
          if (pendingRouteChange) saveRoute(pendingRouteChange.to);
        }}
        onCancel={() => {
          setPendingRouteChange(null);
          setRouteFailure(null);
        }}
      />

      {selectedProfileId != null && (
        <ShareBuildExportDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          profileId={selectedProfileId}
        />
      )}
    </PageShell>
  );
}

import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
import SlicerLinksPanel from "../components/export/SlicerLinksPanel";
import SlicerHandoffPanel from "../components/export/SlicerHandoffPanel";
import WorkPackageCard from "../components/export/WorkPackageCard";
import { useProductionCheckoffLinks } from "../components/export/useProductionCheckoffLinks";
import { useProductionSendFleet } from "../components/export/useProductionSendFleet";
import AcceptedPlateSection from "../components/export/accepted-plates/AcceptedPlateSection";
// Lazy: PrinterSendPanel pulls in heavy printer integration + dnd-kit
const PrinterSendPanel = lazy(() => import("../components/export/PrinterSendPanel"));
import ShareBuildExportDialog from "../components/share/ShareBuildExportDialog";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useProductionSelection } from "../hooks/useProductionSelection";
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
import { projectWorkPackages } from "../lib/workPackageProjection";
import {
  firstUnfinishedProductionTask,
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
 * Production — the Build's work packages.
 *
 * The old four numbered tabs promised one uninterrupted pass. The real task
 * leaves the product: export, slice somewhere else, come back later with
 * G-code, send it, wait, then verify in Checkoff. So this page shows work
 * packages with a durable status and four resumable tasks projected from real
 * records (production setup, Plate revision, export jobs, printer checkoff
 * links), not from a `?stage=` URL parameter. Choosing units, assigning printers,
 * and arranging Plates stay together because they produce one Plate revision.
 *
 * The old `?stage=` and `?select=` links still work as aliases.
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
  const { selection, setSelection, setupSaving, setupError, setup } = useProductionSelection(
    selectableUnits,
    selectParam,
    selectedProfileId,
  );
  const selectedTokens = selectedProductionTokens(selectableUnits, selection);

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
    : "Build after assignment";
  const tasks = useMemo(() => {
    if (!projection.bench) return [];
    return productionTasks({
      pkg: projection.bench,
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
  }, [
    assignFailure,
    exportFailure,
    plateFailure,
    printerCount,
    projection,
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
   * the user can jump to any available task.
   */
  const requestedTask = productionTaskFromParam(
    searchParams.get("task") ?? searchParams.get("stage"),
  );
  const resumeTask = tasks.length > 0 ? firstUnfinishedProductionTask(tasks) : "prepare-plates";
  /**
   * An old link may point at a task that is genuinely blocked now. The link
   * still works, but it opens the resume task and says what is missing rather
   * than pretending the blocked task is available.
   */
  const blockedRequest = requestedTask
    ? tasks.find((task) => task.id === requestedTask && task.state === "blocked")
    : undefined;
  const activeTaskId: ProductionTaskId =
    requestedTask && !blockedRequest ? requestedTask : resumeTask;
  const activeTask = tasks.find((task) => task.id === activeTaskId);

  const openTask = (taskId: ProductionTaskId) => {
    const params = new URLSearchParams(searchParams);
    params.set("task", taskId);
    params.set("stage", productionStageAlias(taskId));
    setSearchParams(params, { replace: true });
  };

  const resumeHere = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("task");
    params.delete("stage");
    setSearchParams(params, { replace: true });
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

  const preparePlatesPanel = (
    <div className="space-y-4">
      <nav
        aria-label="Plate builder"
        className="grid gap-2 rounded-lg border border-border bg-card p-2 shadow-sm sm:grid-cols-3"
      >
        {[
          { href: "#plate-builder-units", step: "1", label: "Units", status: `${selectedTokens.length} selected` },
          { href: "#plate-builder-printers", step: "2", label: "Printers", status: printerAssignmentStatus },
          { href: "#plate-builder-layout", step: "3", label: "Plate layout", status: plateLayoutStatus },
        ].map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="flex min-h-14 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border bg-background font-mono text-xs font-semibold">
              {item.step}
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{item.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{item.status}</span>
            </span>
          </a>
        ))}
      </nav>
      <section
        id="plate-builder-units"
        className="scroll-mt-4 space-y-3 rounded-lg border border-border bg-card p-4"
        aria-labelledby="production-choose-units-heading"
      >
        <div className="space-y-1">
          <h4 id="production-choose-units-heading" className="text-sm font-semibold">
            1. Choose what to make
          </h4>
          <p className="text-xs text-muted-foreground">
            Select the Required units for this work package. Completed units stay out unless you choose them again.
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
              to assign the selected units and build Plates.
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
      <PrinterSendPanel
        remainingParts={remainingParts}
        profileId={selectedProfileId}
        planName={planName}
        engineReady={engineState === "ready"}
        onSlicedFileChange={setSlicedFile}
        onFailure={setSendFailure}
      />
    </Suspense>
  );

  const panelFor = (taskId: ProductionTaskId) => {
    switch (taskId) {
      case "prepare-plates":
        return preparePlatesPanel;
      case "export-for-slicing":
        return exportPanel;
      case "add-sliced-file":
      case "send-or-start":
        return sendPanel;
    }
  };

  return (
    <PageShell>
      <PageHeader
        icon={FileArchive}
        accent
        eyebrow={planIdentity ? `Make · ${planIdentity}` : "Make"}
        title="Production"
        description="Choose units, assign them to printers, build Plates, and send them to print."
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
              <TaskList
                title="Prepare this work package"
                description="Plate preparation stays together. Production reopens at the first unfinished task."
                tasks={taskRows}
              />
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
                  {panelFor(activeTaskId)}
                </section>
              ) : null}
            </WorkPackageCard>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="min-h-11"
              onClick={() => {
                setSelection(new Set(
                  selectableUnits.filter((unit) => !unit.completed).map((unit) => unit.token),
                ));
                openTask("prepare-plates");
              }}
            >
              Prepare more units
            </Button>
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

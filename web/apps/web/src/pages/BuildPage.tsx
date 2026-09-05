import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";
import {
  Archive,
  Copy,
  Hammer,
  Layers,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import MergeConflictBanner from "../components/MergeConflictBanner";
import PlanSpecialRequestField from "../components/PlanSpecialRequestField";
import BuildRecipePanel from "../components/build/BuildRecipePanel";
import PlanRolesCard from "../components/build/PlanRolesCard";
import BuildPlanningCard from "../components/build/BuildPlanningCard";
import BuildSummaryHeader from "../components/build/BuildSummaryHeader";
import BuildSourceGuide from "../components/build/BuildSourceGuide";
import { useBuildPlanningQuery } from "../components/build/useBuildPlanningQuery";
import EmptyState from "../components/layout/EmptyState";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import PageShell from "../components/layout/PageShell";
import TaskList, { type WorkflowTask } from "../components/layout/TaskList";
import KitManifestOptions from "../components/KitManifestOptions";
import SourceCategorySheet from "../components/sources/SourceCategorySheet";
import SourceFilePickerCard from "../components/SourceFilePickerCard";
import ShareImportSetupPanel, {
  type UnmatchedSource,
} from "../components/share/ShareImportSetupPanel";
import type { StlNamingProfile } from "@print-partner/contracts";
import {
  DEFAULT_STL_NAMING_PROFILE,
  mcpAccessEnabled,
} from "@print-partner/contracts";
import type { KitImportJobResult } from "../api/endpoints/imports";
import { Badge } from "../components/ui/badge";
import { Combobox } from "../components/ui/combobox";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { fetchStlNaming } from "../api/endpoints/stlNaming";
import { startSync } from "../api/endpoints/jobs";
import type { ProfileLayer } from "../api/endpoints/plans";
import type { RoleFilamentRow } from "../api/endpoints/filaments";
import {
  useSourcesQuery,
  useUpdateSourceMutation,
  type SourceSummary,
} from "../queries/sources";
import { useSourceCategoriesQuery } from "../queries/sourceCategories";
import { queryKeys } from "../queries/keys";
import {
  invalidatePlanStructure,
  useAddPlanAddonLayerMutation,
  useDeletePlanLayerMutation,
  usePlanLayersQuery,
  useReplacePlanLayerMutation,
  useSetPlanBaseLayerMutation,
} from "../queries/planLayers";
import { libraryRoute, settingsRoute } from "../lib/routes";
import { groupMergeConflictsByFilename } from "../lib/mergeConflictGroups";
import { takeKitImportResult } from "../lib/kitImportStash";
import { statusTone } from "../lib/statusTone";
import { sourceContentAvailable } from "../lib/sourceContentAvailable";
import { cn } from "@/lib/utils";
import { useProfileSelection } from "../context/ProfileContext";
import { usePlanActions } from "../context/PlanActionsContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useImportRulesSaveRegistry } from "../context/ImportRulesSaveContext";
import { useKitManifestSaveRegistry } from "../context/KitManifestSaveContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useExternalAccessSettingsQuery } from "../queries/externalAccess";
import { useJobRunner } from "../hooks/useJobRunner";
import { meshColorForStlPath } from "../lib/rolePreviewColor";
import { buildPageDerivedState } from "../lib/buildPageViewModel";
import {
  sourcesSetupTasks,
  type SourcesSetupAction,
  type SourcesSetupHandlerId,
  type SourcesSetupSource,
} from "../lib/sourcesSetupTasks";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
} from "../lib/workflowState";
import {
  attachedPlanSourceIds,
  basePlanLayer,
  buildSourceLayerRows,
  sourceSelectOptions,
  unattachedSources,
} from "../lib/buildSourceLayers";

type BuildLocationState = {
  kitImport?: KitImportJobResult;
};

const EMPTY_SOURCES: SourceSummary[] = [];
const EMPTY_LAYERS: ProfileLayer[] = [];

/** Move the reader to a section and let a screen reader announce it. */
function revealSection(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
}

export default function BuildPage() {
  return <BuildPageContent />;
}

/**
 * Sources is a setup workspace. It answers "are the inputs ready for a Plan?"
 * with a task list, one primary action, the attached sources, and the advanced
 * settings behind a disclosure. Working Plan review and acceptance live on Plan.
 */
function BuildPageContent() {
  const location = useLocation();
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const {
    selectedProfileId,
    reloadProfiles,
    profiles,
    loading: profilesLoading,
    error: profilesError,
  } = useProfileSelection();
  const {
    openCreatePlan,
    openRenamePlan,
    openDuplicatePlan,
    openDeletePlan,
    openArchivePlan,
  } = usePlanActions();
  const { review, refresh: refreshPlan } = usePlanWorkspace();
  const previousSelectedProfileIdRef = useRef<number | null | undefined>(undefined);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [addonSourceId, setAddonSourceId] = useState("");
  const [pendingBaseSourceId, setPendingBaseSourceId] = useState("");
  const [kitImportSetup, setKitImportSetup] = useState<KitImportJobResult | null>(null);
  const [categoriesSheetOpen, setCategoriesSheetOpen] = useState(false);
  const filamentRefreshKey = 0;
  const [roleFilaments, setRoleFilaments] = useState<RoleFilamentRow[]>([]);
  const [namingProfile, setNamingProfile] = useState<StlNamingProfile>(DEFAULT_STL_NAMING_PROFILE);
  const [attachOpen, setAttachOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const engineReady = engineState === "ready";
  const queryClient = useQueryClient();
  const sourcesQuery = useSourcesQuery(engineReady);
  const sources = sourcesQuery.data ?? EMPTY_SOURCES;
  const categoriesQuery = useSourceCategoriesQuery(engineReady);
  const categories = categoriesQuery.data ?? [];
  const layersQuery = usePlanLayersQuery(selectedProfileId, engineReady);
  const layers = layersQuery.data ?? EMPTY_LAYERS;
  const layerProfileId = selectedProfileId ?? 0;
  const setBaseMutation = useSetPlanBaseLayerMutation(layerProfileId);
  const addAddonMutation = useAddPlanAddonLayerMutation(layerProfileId);
  const replaceLayerMutation = useReplacePlanLayerMutation(layerProfileId);
  const deleteLayerMutation = useDeletePlanLayerMutation(layerProfileId);
  const updateSourceMutation = useUpdateSourceMutation();
  const externalAccessQuery = useExternalAccessSettingsQuery(engineReady);
  const showMcpTools = externalAccessQuery.data
    ? mcpAccessEnabled(externalAccessQuery.data.mode)
    : false;
  const planningQuery = useBuildPlanningQuery({
    planId: selectedProfileId,
    enabled: engineReady && showMcpTools,
  });
  const syncJob = useJobRunner("sync");
  const sourceQueryError =
    sourcesQuery.error instanceof Error
      ? sourcesQuery.error.message
      : sourcesQuery.error
        ? String(sourcesQuery.error)
        : null;
  const categoryError =
    categoriesQuery.error instanceof Error
      ? `Could not load source categories: ${categoriesQuery.error.message}`
      : categoriesQuery.error
        ? `Could not load source categories: ${String(categoriesQuery.error)}`
        : null;
  const layerQueryError =
    layersQuery.error instanceof Error
      ? layersQuery.error.message
      : layersQuery.error
        ? String(layersQuery.error)
        : null;
  const profileDataError = loadError ?? layerQueryError;

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
  const buildStale = selectedProfile?.freshness.status === "stale";

  const mergeConflicts = useMemo(
    () => review?.issues.filter((i) => i.code === "merge_conflict") ?? [],
    [review],
  );
  const mergeConflictGroups = useMemo(
    () => groupMergeConflictsByFilename(mergeConflicts),
    [mergeConflicts],
  );

  useEffect(() => {
    if (!health?.ok) return;
    void fetchStlNaming()
      .then(setNamingProfile)
      .catch((e) =>
        toast.error("Could not load STL naming settings", {
          description: e instanceof Error ? e.message : String(e),
        }),
      );
  }, [health?.ok]);

  const resolvePreviewMeshColor = useCallback(
    (relativePath: string) => meshColorForStlPath(relativePath, namingProfile, roleFilaments),
    [namingProfile, roleFilaments],
  );

  const onRoleFilamentsUpdated = useCallback(async () => {
    await refreshPlan();
  }, [refreshPlan]);

  useEffect(() => {
    const state = location.state as BuildLocationState | null;
    if (state?.kitImport) {
      setKitImportSetup(state.kitImport);
      window.history.replaceState({}, document.title);
      return;
    }
    // Fall back to the sessionStorage stash in case location.state was dropped
    // by an intervening navigation (e.g. ?profile= URL sync).
    if (selectedProfileId != null) {
      const stashed = takeKitImportResult(selectedProfileId);
      if (stashed) setKitImportSetup(stashed);
    }
  }, [location.state, selectedProfileId]);

  const assignSourceCategory = useCallback(
    async (sourceId: number, category: string | null) => {
      const source = sources.find((s) => s.id === sourceId);
      if (!source) return;
      const previous = source.category ?? null;
      const next = category?.trim() || null;
      if (previous === next) return;
      try {
        const updated = await updateSourceMutation.mutateAsync({
          id: sourceId,
          body: { category: next },
        });
        toast.success(
          next
            ? `Moved “${updated.name}” to ${next}`
            : `Moved “${updated.name}” to Uncategorised`,
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [sources, updateSourceMutation],
  );

  useEffect(() => {
    const previousId = previousSelectedProfileIdRef.current;
    const profileChanged = previousId !== undefined && previousId !== selectedProfileId;
    previousSelectedProfileIdRef.current = selectedProfileId;

    if (selectedProfileId == null) {
      setAddonSourceId("");
      setPendingBaseSourceId("");
      setRoleFilaments([]);
      return;
    }
    if (profileChanged) {
      setAddonSourceId("");
      setPendingBaseSourceId("");
      setRoleFilaments([]);
      setLoadError(null);
      setSyncError(null);
    }
  }, [selectedProfileId]);

  const baseLayer = useMemo(() => basePlanLayer(layers), [layers]);
  const attachedSourceIds = useMemo(() => attachedPlanSourceIds(layers), [layers]);

  const addonSourceOptions = useMemo(
    () => unattachedSources(sources, attachedSourceIds),
    [sources, attachedSourceIds],
  );

  const baseSourceOptions = useMemo(() => sourceSelectOptions(sources), [sources]);

  const addonComboboxOptions = useMemo(
    () => sourceSelectOptions(addonSourceOptions),
    [addonSourceOptions],
  );

  useEffect(() => {
    if (addonSourceId && !addonSourceOptions.some((s) => String(s.id) === addonSourceId)) {
      setAddonSourceId("");
    }
  }, [addonSourceId, addonSourceOptions]);

  const sourceById = useMemo(() => {
    const map = new Map<number, SourceSummary>();
    for (const s of sources) map.set(s.id, s);
    return map;
  }, [sources]);

  const sourceCardLayers = useMemo(() => buildSourceLayerRows(layers), [layers]);

  const needsBaseSource = baseLayer?.project_id == null;

  const { flushAll: flushImportRules } = useImportRulesSaveRegistry();
  const { flushAll: flushKitManifest } = useKitManifestSaveRegistry();

  const flushPendingSaves = useCallback(async () => {
    await Promise.all([flushImportRules(), flushKitManifest()]);
  }, [flushImportRules, flushKitManifest]);

  useEffect(() => {
    return () => {
      void flushPendingSaves();
    };
  }, [flushPendingSaves]);

  const attachedSources = useMemo(
    () =>
      sourceCardLayers
        .map((row) => sourceById.get(row.sourceId))
        .filter((s): s is SourceSummary => s != null),
    [sourceCardLayers, sourceById],
  );

  const { archiveAllowed, headerSubtitle } = buildPageDerivedState({
    selectedProfile,
    review,
    attachedSources,
    roleFilaments,
    sourceCardLayerCount: sourceCardLayers.length,
    buildStale,
  });
  const profilesState = resolveResourceState({
    loading: profilesLoading,
    error: profilesError,
    hasData: profiles.length > 0,
  });
  const hasProfileData = layersQuery.data != null;
  const profileDataState = resolveResourceState({
    loading: layersQuery.isLoading,
    error: profileDataError,
    hasData: hasProfileData,
  });
  const sourcesState = resolveResourceState({
    loading: sourcesQuery.isLoading,
    error: sourceQueryError,
    hasData: sourcesQuery.data != null,
  });
  const profilesBackgroundError = getBackgroundError(
    profilesError,
    profiles.length > 0,
  );
  const profileDataBackgroundError = getBackgroundError(profileDataError, hasProfileData);
  const sourcesBackgroundError = getBackgroundError(
    sourceQueryError,
    sourcesQuery.data != null,
  );
  const workspaceReady =
    engineReady &&
    profilesState === "ready" &&
    profiles.length > 0 &&
    selectedProfileId != null &&
    profileDataState === "ready" &&
    sourcesState === "ready";

  const busy = syncJob.busy;

  const reviewLayerById = useMemo(() => {
    const map = new Map<number, { synced: boolean }>();
    for (const layer of review?.layers ?? []) map.set(layer.id, { synced: layer.synced });
    return map;
  }, [review]);

  const setupSources = useMemo<SourcesSetupSource[]>(
    () =>
      sourceCardLayers.map((row) => {
        const source = sourceById.get(row.sourceId);
        const reviewLayer = reviewLayerById.get(row.layer.id);
        return {
          id: row.sourceId,
          name: row.sourceName,
          layerType: row.layerType,
          synced: reviewLayer ? reviewLayer.synced : sourceContentAvailable(source),
          updatesAvailable: source?.update_status === "updates_available",
        };
      }),
    [sourceCardLayers, sourceById, reviewLayerById],
  );

  const syncTargets = useMemo(
    () =>
      setupSources
        .filter((source) => !source.synced || source.updatesAvailable)
        .map((source) => source.id),
    [setupSources],
  );

  const syncAttachedSources = useCallback(async () => {
    const ids = syncTargets.length > 0 ? syncTargets : setupSources.map((s) => s.id);
    if (ids.length === 0) return;
    setSyncError(null);
    await syncJob.runJob(
      () => startSync(ids),
      (snapshot) => {
        if (snapshot.status === "error") {
          setSyncError(
            snapshot.message ??
              "Sync failed. The attached sources were left unchanged.",
          );
          return;
        }
        void sourcesQuery.refetch();
        if (selectedProfileId != null) {
          void invalidatePlanStructure(queryClient, selectedProfileId);
          void queryClient.invalidateQueries({
            queryKey: queryKeys.buildWorkflow(selectedProfileId),
          });
        }
        void refreshPlan();
      },
      { sourceIds: ids, profileId: selectedProfileId },
    );
  }, [
    queryClient,
    refreshPlan,
    selectedProfileId,
    setupSources,
    sourcesQuery,
    syncJob,
    syncTargets,
  ]);

  const setup = useMemo(
    () =>
      sourcesSetupTasks({
        buildId: selectedProfileId ?? 0,
        specialRequest: selectedProfile?.special_request,
        sources: setupSources,
        mergeConflictCount: mergeConflicts.length,
        roleFilaments,
        syncing: syncJob.busy,
      }),
    [
      mergeConflicts.length,
      roleFilaments,
      selectedProfile,
      selectedProfileId,
      setupSources,
      syncJob.busy,
    ],
  );

  const runSetupHandler = useCallback(
    (handler: SourcesSetupHandlerId) => {
      switch (handler) {
        case "confirm_request": {
          revealSection("build-request");
          const field = document.getElementById(
            `plan-special-request-${selectedProfileId ?? 0}`,
          );
          if (field instanceof HTMLInputElement) field.focus();
          return;
        }
        case "attach_source":
          if (!needsBaseSource) setAttachOpen(true);
          revealSection("attached-sources");
          return;
        case "sync_sources":
          void syncAttachedSources();
          return;
        case "resolve_differences":
          revealSection("attached-sources");
          return;
        case "assign_colors":
          revealSection("materials");
          return;
        default: {
          const exhaustive: never = handler;
          return exhaustive;
        }
      }
    },
    [needsBaseSource, selectedProfileId, syncAttachedSources],
  );

  const tasks = useMemo<WorkflowTask[]>(
    () =>
      setup.tasks.map((task) => {
        const action = task.action;
        const base: WorkflowTask = {
          id: task.id,
          label: task.label,
          hint: task.hint,
          state: task.state,
          statusLabel: task.statusLabel,
          error:
            task.id === "sync-sources" && syncError
              ? {
                  message: syncError,
                  onRetry: () => void syncAttachedSources(),
                  retryLabel: "Retry sync",
                }
              : undefined,
        };
        if (!action) return base;
        if (action.kind === "route") return { ...base, to: action.to };
        return {
          ...base,
          actionLabel: action.label,
          onAction: () => runSetupHandler(action.handler),
        };
      }),
    [runSetupHandler, setup.tasks, syncAttachedSources, syncError],
  );

  const primaryAction: SourcesSetupAction = setup.primary.action;

  const onChangeLayerProject = async (layer: ProfileLayer, projectId: number) => {
    if (selectedProfileId == null) return;
    setLoadError(null);
    try {
      if (layer.layer_type === "base") {
        await setBaseMutation.mutateAsync(projectId);
      } else {
        await replaceLayerMutation.mutateAsync({
          layerId: layer.id,
          sourceId: projectId,
        });
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRemoveLayer = async (layer: ProfileLayer) => {
    if (selectedProfileId == null) return;
    setLoadError(null);
    try {
      await deleteLayerMutation.mutateAsync(layer.id);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const onAddAddon = async () => {
    if (selectedProfileId == null || !addonSourceId) return;
    setLoadError(null);
    try {
      await addAddonMutation.mutateAsync(Number(addonSourceId));
      setAddonSourceId("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSetBaseSource = async () => {
    if (selectedProfileId == null || !pendingBaseSourceId) return;
    setLoadError(null);
    try {
      await setBaseMutation.mutateAsync(Number(pendingBaseSourceId));
      setPendingBaseSourceId("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <PageShell>
      <PageHeader
        icon={Hammer}
        accent
        eyebrow="Prepare"
        title="Sources"
        description={headerSubtitle}
        actions={workspaceReady ? (
          <PageHeaderActions>
            {primaryAction.kind === "route" ? (
              <Button className="min-h-11 w-full sm:w-auto" asChild>
                <Link to={primaryAction.to}>{primaryAction.label}</Link>
              </Button>
            ) : (
              <Button
                className="min-h-11 w-full sm:w-auto"
                onClick={() => runSetupHandler(primaryAction.handler)}
                disabled={busy || !engineReady}
                loading={busy}
              >
                {primaryAction.label}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-11 w-11"
                  disabled={selectedProfileId == null || !engineReady}
                  aria-label="Build actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => openDuplicatePlan()}
                  disabled={selectedProfileId == null}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openRenamePlan()}
                  disabled={selectedProfileId == null}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                {archiveAllowed ? (
                  <DropdownMenuItem
                    onClick={() => openArchivePlan()}
                    disabled={selectedProfileId == null}
                  >
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onClick={() => openDeletePlan()}
                  disabled={selectedProfileId == null}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </PageHeaderActions>
        ) : undefined}
      />

      <BuildSummaryHeader currentStageId="sources" />

      {(profilesBackgroundError ||
        profileDataBackgroundError ||
        sourcesBackgroundError ||
        categoryError) && (
        <div className="space-y-1 text-sm text-destructive" role="alert">
          {profilesBackgroundError && (
            <p>Could not refresh Builds: {profilesBackgroundError}</p>
          )}
          {profileDataBackgroundError && (
            <p>Could not refresh this Build: {profileDataBackgroundError}</p>
          )}
          {sourcesBackgroundError && (
            <p>Could not refresh sources: {sourcesBackgroundError}</p>
          )}
          {categoryError && <p>{categoryError}</p>}
        </div>
      )}

      {workspaceReady && (
        <TaskList
          title="Setup tasks"
          description={
            setup.ready
              ? "The inputs are ready. Review the Working Plan on Plan."
              : "Get the inputs ready before the Plan is reviewed."
          }
          tasks={tasks}
        />
      )}

      {engineState !== "ready" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Engine offline — start the print-partner engine to edit a Build."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      ) : profilesState === "error" ? (
        <Card className={cn("shadow-none", statusTone({ tone: "error", emphasis: "surface" }))}>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive">
              Could not load Builds: {profilesError}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void reloadProfiles()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : profilesState === "loading" ? (
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading Builds…</p>
          </CardContent>
        </Card>
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={Hammer}
          title="No Build yet"
          description="Use New Build in the sidebar (or the + button on mobile) to name a Build, then attach sources and pick STL files below."
          action={{
            label: "New Build",
            onClick: openCreatePlan,
          }}
        />
      ) : selectedProfileId == null ? (
        <EmptyState
          icon={Hammer}
          title="Select a Build"
          description="Choose a Build in the sidebar picker (or the mobile Build switcher in the header)."
        />
      ) : sourcesState === "loading" ? (
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading sources…</p>
          </CardContent>
        </Card>
      ) : sourcesState === "error" ? (
        <Card className={cn("shadow-none", statusTone({ tone: "error", emphasis: "surface" }))}>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive">
              Could not load sources: {sourceQueryError}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void sourcesQuery.refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : profileDataState === "loading" ? (
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading this Build…</p>
          </CardContent>
        </Card>
      ) : profileDataState === "error" ? (
        <Card className={cn("shadow-none", statusTone({ tone: "error", emphasis: "surface" }))}>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive">
              Could not load this Build: {profileDataError}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setLoadError(null);
                void layersQuery.refetch();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {workspaceReady &&
        kitImportSetup &&
        ((kitImportSetup.unmatched_sources?.length ?? 0) > 0 ||
          (kitImportSetup.warnings?.length ?? 0) > 0) && (
          <ShareImportSetupPanel
            unmatchedSources={(kitImportSetup.unmatched_sources ?? []) as UnmatchedSource[]}
            warnings={kitImportSetup.warnings ?? []}
            profileId={kitImportSetup.profile_id}
            onDismiss={() => setKitImportSetup(null)}
            onSourcesChanged={() => {
              void sourcesQuery.refetch();
              if (selectedProfileId != null) {
                void invalidatePlanStructure(queryClient, selectedProfileId);
              }
            }}
          />
        )}

      {workspaceReady && selectedProfileId != null && (
        <div className="space-y-6">
          <section id="build-request" className="space-y-2">
            <h2 className="text-sm font-semibold tracking-wide">Build request</h2>
            <label
              htmlFor={`plan-special-request-${selectedProfileId}`}
              className="block text-xs text-muted-foreground"
            >
              Special request for this Build
            </label>
            <PlanSpecialRequestField
              profileId={selectedProfileId}
              value={selectedProfile?.special_request}
              className="max-w-xl"
            />
          </section>

          <section id="attached-sources" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-wide">
                Print sources
              </h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setAttachOpen((v) => !v)}
                  disabled={!engineReady || busy}
                >
                  Attach from Library
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to={libraryRoute()}>Manage Source Library</Link>
                </Button>
              </div>
            </div>
            <p className="max-w-3xl text-xs text-muted-foreground">
              Attach the Library projects that contain this Build's parts. For each source, choose
              the folders or individual STL files that belong in the Plan.
            </p>

            <BuildSourceGuide profileId={selectedProfileId} />

            {mergeConflicts.length > 0 && (
              <MergeConflictBanner
                conflictCount={mergeConflicts.length}
                groupedByFilename={mergeConflictGroups}
              />
            )}

            {needsBaseSource && (
              <Card className="border-dashed">
                <CardHeader className="p-4">
                  <div className="flex flex-wrap items-start gap-2">
                    <Badge variant="base" icon={Layers}>
                      base
                    </Badge>
                    <div className="min-w-0 flex-1 space-y-1">
                      <CardTitle className="text-sm">Choose base source</CardTitle>
                      <CardDescription className="text-xs">
                        Pick the main kit project for this Build before adding addons or
                        importing files.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 p-4 pt-0">
                  <Combobox
                    value={pendingBaseSourceId || null}
                    onValueChange={setPendingBaseSourceId}
                    disabled={!engineReady || busy || selectedProfileId == null}
                    placeholder="Choose base source…"
                    searchPlaceholder="Search sources…"
                    emptyText="No sources match."
                    options={baseSourceOptions}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => void onSetBaseSource()}
                    disabled={!pendingBaseSourceId || selectedProfileId == null || !engineReady || busy}
                  >
                    Set base source
                  </Button>
                </CardContent>
              </Card>
            )}

            <div className="flex flex-col gap-2">
              {sourceCardLayers.map((row) => (
                <SourceFilePickerCard
                  key={row.key}
                  sourceId={row.sourceId}
                  sourceName={row.sourceName}
                  layerType={row.layerType}
                  source={sourceById.get(row.sourceId) ?? null}
                  allSources={sources}
                  disabled={!engineReady || busy}
                  onChangeSource={(projectId) => void onChangeLayerProject(row.layer, projectId)}
                  onAssignCategory={(category) =>
                    void assignSourceCategory(row.sourceId, category)
                  }
                  onRemove={
                    row.layerType === "addon"
                      ? () => void onRemoveLayer(row.layer)
                      : undefined
                  }
                  meshColorForPath={resolvePreviewMeshColor}
                />
              ))}
            </div>

            {(attachOpen || addonSourceId) && (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Combobox
                  value={addonSourceId || null}
                  onValueChange={setAddonSourceId}
                  disabled={
                    !engineReady ||
                    busy ||
                    selectedProfileId == null ||
                    needsBaseSource ||
                    addonSourceOptions.length === 0
                  }
                  placeholder={
                    addonSourceOptions.length === 0
                      ? "All sources already attached"
                      : "Attach another source…"
                  }
                  searchPlaceholder="Search sources…"
                  emptyText="No sources match."
                  options={addonComboboxOptions}
                  className="min-h-11 w-full min-w-0 flex-1 sm:w-auto"
                  contentClassName="min-w-[16rem]"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="min-h-11 w-full sm:w-auto"
                  onClick={() => {
                    void onAddAddon();
                    setAttachOpen(false);
                  }}
                  disabled={!addonSourceId || needsBaseSource || busy}
                >
                  Attach
                </Button>
              </div>
            )}
          </section>

          <section id="materials" className="space-y-3">
            <h2 className="text-sm font-semibold tracking-wide">Materials and colors</h2>
            <PlanRolesCard
              profileId={selectedProfileId}
              disabled={!engineReady || busy}
              refreshKey={filamentRefreshKey}
              roleFilaments={roleFilaments}
              onRolesChange={setRoleFilaments}
              onUpdated={onRoleFilamentsUpdated}
            />
          </section>

          {showMcpTools && planningQuery.data ? (
            <section id="assistant-changes" className="space-y-3">
              <h2 className="text-sm font-semibold tracking-wide">AI MCP Server changes</h2>
              <details open={assistantOpen} onToggle={(e) => setAssistantOpen(e.currentTarget.open)}>
                <summary className="cursor-pointer select-none text-sm text-muted-foreground transition-colors hover:text-foreground">
                  Review changes proposed by the AI MCP Server
                </summary>
                <div className="mt-3">
                  <BuildPlanningCard planId={selectedProfileId} />
                </div>
              </details>
            </section>
          ) : null}

          <details id="advanced-source-settings" className="rounded-lg border border-border bg-card/40 p-4">
            <summary className="cursor-pointer select-none text-sm font-semibold text-foreground">
              Advanced source settings
            </summary>
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  className="min-h-11"
                  onClick={() => setCategoriesSheetOpen(true)}
                >
                  Source categories…
                </Button>
                <Button variant="secondary" size="sm" className="min-h-11" asChild>
                  <Link to={`${settingsRoute()}#stl-naming`}>Part naming rules</Link>
                </Button>
                {categories.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {categories.length} categories in the Library.
                  </p>
                ) : null}
              </div>

              {baseLayer?.project_id != null ? (
                <KitManifestOptions
                  profileId={selectedProfileId}
                  baseSourceName={baseLayer.project_name ?? "base"}
                  buildStale={buildStale}
                  disabled={!engineReady || busy}
                  compact
                />
              ) : null}

              <BuildRecipePanel profileId={selectedProfileId} />
            </div>
          </details>
        </div>
      )}

      <SourceCategorySheet
        open={categoriesSheetOpen}
        onOpenChange={setCategoriesSheetOpen}
        engineReady={engineReady}
      />
    </PageShell>
  );
}

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
import PlanFreshnessNotice from "../components/PlanFreshnessNotice";
import MergeConflictBanner from "../components/MergeConflictBanner";
import PlanSpecialRequestField from "../components/PlanSpecialRequestField";
import BuildSourcesPanel from "../components/build/BuildSourcesPanel";
import BuildRecipePanel from "../components/build/BuildRecipePanel";
import PlanRolesCard from "../components/build/PlanRolesCard";
import PlanWarningsCard from "../components/build/PlanWarningsCard";
import PlanCategoryDropStrip from "../components/build/PlanCategoryDropStrip";
import BuildPlanningCard from "../components/build/BuildPlanningCard";
import DeskNextStep from "../components/layout/DeskNextStep";
import EmptyState from "../components/layout/EmptyState";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import PageShell from "../components/layout/PageShell";
import KitManifestOptions from "../components/KitManifestOptions";
import SourceCategorySheet from "../components/sources/SourceCategorySheet";
import SourceFilePickerCard from "../components/SourceFilePickerCard";
import ShareImportSetupPanel, {
  type UnmatchedSource,
} from "../components/share/ShareImportSetupPanel";
import type { KitImportJobResult, PlanDraftWorkspace } from "../api/engine";
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
import {
  EngineHttpError,
  fetchStlNaming,
  type ProfileLayer,
  type RequiredUnitDecisionContract,
  type RoleFilamentRow,
  DEFAULT_STL_NAMING_PROFILE,
  type StlNamingProfile,
} from "../api/engine";
import {
  useSourcesQuery,
  useUpdateSourceMutation,
  type SourceSummary,
} from "../queries/sources";
import { useSourceCategoriesQuery } from "../queries/sourceCategories";
import {
  invalidatePlanStructure,
  useAddPlanAddonLayerMutation,
  useDeletePlanLayerMutation,
  usePlanLayersQuery,
  useReplacePlanLayerMutation,
  useSetPlanBaseLayerMutation,
} from "../queries/planLayers";
import { exportRoute, libraryRoute } from "../lib/routes";
import { groupMergeConflictsByFilename } from "../lib/mergeConflictGroups";
import { takeKitImportResult } from "../lib/kitImportStash";
import { deskNextStepLine } from "../lib/deskNextStep";
import { buildPlanWarningLines, planHeaderSubtitle } from "../lib/planWarnings";
import { planHasUnsetRoleColors } from "../lib/roleColorSet";
import { useProfileSelection } from "../context/ProfileContext";
import { usePlanActions } from "../context/PlanActionsContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useImportRulesSaveRegistry } from "../context/ImportRulesSaveContext";
import { useKitManifestSaveRegistry } from "../context/KitManifestSaveContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { meshColorForStlPath } from "../lib/rolePreviewColor";
import { checkoffUnitTotals } from "../lib/checkoffProgress";
import { canArchivePlan } from "../lib/planPickerGroups";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
} from "../lib/workflowState";

type ProductionBlock = {
  readonly checkoffLinkCount: number;
  readonly sendQueueItemCount: number;
};

export function planDraftProductionBlockFromError(caught: unknown): ProductionBlock | null {
  if (!(caught instanceof EngineHttpError) || caught.status !== 423) return null;
  if (!caught.body || typeof caught.body !== "object") return null;
  const body = caught.body;
  if (!("code" in body) || body.code !== "production_active") return null;
  return {
    checkoffLinkCount:
      "checkoff_link_count" in body && typeof body.checkoff_link_count === "number"
        ? body.checkoff_link_count
        : 0,
    sendQueueItemCount:
      "send_queue_item_count" in body && typeof body.send_queue_item_count === "number"
        ? body.send_queue_item_count
        : 0,
  };
}

type BuildLocationState = {
  kitImport?: KitImportJobResult;
};

export function planDraftRevisionPartLabels(
  workspace: PlanDraftWorkspace,
): ReadonlyMap<number, string> {
  const labels = new Map<number, string>();
  for (const part of workspace.parts) {
    if (part.base_revision_part_id != null) {
      labels.set(part.base_revision_part_id, part.filename);
    }
  }
  for (const change of workspace.diff.changed) {
    labels.set(change.before.revision_part_id, change.before.filename);
  }
  for (const part of workspace.diff.removed) {
    labels.set(part.revision_part_id, part.filename);
  }
  return labels;
}

export function PlanDraftApplyButton({
  workspace,
  busy,
  onApply,
  onRebase,
}: {
  workspace: PlanDraftWorkspace;
  busy: boolean;
  onApply: () => void;
  onRebase: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {!workspace.diff.base_is_current && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onRebase}
        >
          Rebase saved draft
        </Button>
      )}
      <Button
        type="button"
        disabled={
          busy ||
          !workspace.diff.base_is_current ||
          workspace.reconciliation.kind !== "ready"
        }
        loading={busy}
        onClick={onApply}
      >
        Apply plan changes
      </Button>
    </div>
  );
}

const EMPTY_SOURCES: SourceSummary[] = [];
const EMPTY_LAYERS: ProfileLayer[] = [];

export default function BuildPage() {
  return <BuildPageContent />;
}

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
  const {
    review,
    refresh: refreshPlan,
    draftWorkspace,
    draftError,
    startPlanDraft,
    applyActivePlanDraft,
    rebaseActivePlanDraft,
    reconcileActivePlanDraft,
  } = usePlanWorkspace();
  const previousSelectedProfileIdRef = useRef<number | null | undefined>(undefined);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [addonSourceId, setAddonSourceId] = useState("");
  const [pendingBaseSourceId, setPendingBaseSourceId] = useState("");
  const [kitImportSetup, setKitImportSetup] = useState<KitImportJobResult | null>(null);
  const [categoriesSheetOpen, setCategoriesSheetOpen] = useState(false);
  const [filamentRefreshKey, setFilamentRefreshKey] = useState(0);
  const [draftActionBusy, setDraftActionBusy] = useState(false);
  const [draftConflictChoices, setDraftConflictChoices] = useState<Record<string, string>>({});
  const [draftProductionBlock, setDraftProductionBlock] = useState<ProductionBlock | null>(null);
  const [roleFilaments, setRoleFilaments] = useState<RoleFilamentRow[]>([]);
  const [namingProfile, setNamingProfile] = useState<StlNamingProfile>(DEFAULT_STL_NAMING_PROFILE);
  const [attachOpen, setAttachOpen] = useState(false);
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
    }
  }, [selectedProfileId]);

  const baseLayer = useMemo(
    () => layers.find((l) => l.layer_type === "base") ?? null,
    [layers],
  );
  const addonLayers = useMemo(
    () => layers.filter((l) => l.layer_type !== "base"),
    [layers],
  );

  const attachedSourceIds = useMemo(() => {
    const ids = new Set<number>();
    for (const layer of layers) {
      if (layer.project_id != null) ids.add(layer.project_id);
    }
    return ids;
  }, [layers]);

  const addonSourceOptions = useMemo(
    () => sources.filter((s) => !attachedSourceIds.has(s.id)),
    [sources, attachedSourceIds],
  );

  const baseSourceOptions = useMemo(
    () => sources.map((s) => ({ value: String(s.id), label: s.name })),
    [sources],
  );

  const addonComboboxOptions = useMemo(
    () => addonSourceOptions.map((s) => ({ value: String(s.id), label: s.name })),
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

  const sourceCardLayers = useMemo(() => {
    const rows: Array<{
      key: string;
      layer: ProfileLayer;
      sourceId: number;
      sourceName: string;
      layerType: "base" | "addon";
    }> = [];
    if (baseLayer?.project_id != null) {
      rows.push({
        key: `base-${baseLayer.id}`,
        layer: baseLayer,
        sourceId: baseLayer.project_id,
        sourceName: baseLayer.project_name ?? "base",
        layerType: "base",
      });
    }
    for (const layer of addonLayers) {
      if (layer.project_id == null) continue;
      rows.push({
        key: `addon-${layer.id}`,
        layer,
        sourceId: layer.project_id,
        sourceName: layer.project_name ?? "addon",
        layerType: "addon",
      });
    }
    return rows;
  }, [baseLayer, addonLayers]);

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

  const partCount =
    selectedProfile?.part_count ?? review?.totals.included_parts ?? 0;

  const includedForArchive =
    review?.part_groups.flatMap((g) => g.parts).filter((p) => p.included) ?? [];
  const archiveTotals = checkoffUnitTotals(includedForArchive);
  const archiveAllowed = canArchivePlan({
    archived: Boolean(selectedProfile?.archived_at),
    totalUnits: archiveTotals.totalUnits,
    remainingUnits: archiveTotals.remainingUnits,
  });

  const planWarnings = buildPlanWarningLines({
    buildStale,
    attachedSources,
    review,
    roleFilaments,
  });

  const colorsUnset = planHasUnsetRoleColors(roleFilaments);
  const planNextStep = deskNextStepLine("plan", {
    attachedSourceCount: sourceCardLayers.length,
    partCount,
    colorsUnset,
  });

  const headerSubtitle = planHeaderSubtitle({
    profile: selectedProfile,
    sourceCount: sourceCardLayers.length,
    partCount,
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

  const onUpdateBuild = async () => {
    if (selectedProfileId == null) return;
    try {
      await flushPendingSaves();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    setDraftActionBusy(true);
    try {
      const workspace = await startPlanDraft();
      setFilamentRefreshKey((key) => key + 1);
      toast.success(
        `Saved Plan draft with ${workspace.diff.added.length + workspace.diff.changed.length + workspace.diff.removed.length} change(s)`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionBusy(false);
    }
  };

  const onApplyDraft = async (options?: { remapCheckoffLinks?: boolean }) => {
    setDraftActionBusy(true);
    try {
      const receipt = await applyActivePlanDraft(options);
      setDraftProductionBlock(null);
      toast.success(`Applied Plan version ${receipt.plan_version}`);
    } catch (error) {
      const productionBlock = planDraftProductionBlockFromError(error);
      if (productionBlock) {
        setDraftProductionBlock(productionBlock);
        toast.error(
          `${productionBlock.checkoffLinkCount} checkoff record(s) are linked to the current Plan. Remap and apply to preserve them, or resolve production first.`,
        );
      } else {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setDraftActionBusy(false);
    }
  };

  const onRebaseDraft = async () => {
    setDraftActionBusy(true);
    try {
      const workspace = await rebaseActivePlanDraft();
      toast.success(`Rebased saved draft ${workspace.draft.draft_id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionBusy(false);
    }
  };

  useEffect(() => {
    setDraftConflictChoices({});
    setDraftProductionBlock(null);
  }, [draftWorkspace?.draft.snapshot_digest]);

  const onResolveDraft = async () => {
    if (!draftWorkspace || draftWorkspace.reconciliation.kind !== "unresolved") return;
    const decisions: RequiredUnitDecisionContract[] = [];
    for (const conflict of draftWorkspace.reconciliation.conflicts) {
      const key = `${conflict.kind}:${conflict.target_draft_part_id}`;
      const choice = draftConflictChoices[key];
      if (!choice) {
        toast.error("Choose how to resolve every Required-unit conflict");
        return;
      }
      if (choice === "replace") {
        decisions.push({ kind: "replace", target_draft_part_id: conflict.target_draft_part_id });
      } else if (conflict.kind === "ambiguous_exact_match") {
        decisions.push({
          kind: "select_exact_predecessor",
          target_draft_part_id: conflict.target_draft_part_id,
          predecessor_revision_part_id: Number(choice),
        });
      } else {
        decisions.push({
          kind: "accept_prior_completion",
          target_draft_part_id: conflict.target_draft_part_id,
          predecessor_revision_part_id: conflict.predecessor_revision_part_id,
        });
      }
    }
    setDraftActionBusy(true);
    try {
      await reconcileActivePlanDraft(decisions);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftActionBusy(false);
    }
  };

  const busy = draftActionBusy;
  const acceptedRevisionPartLabels = draftWorkspace
    ? planDraftRevisionPartLabels(draftWorkspace)
    : new Map<number, string>();
  const proposedPartChanges = draftWorkspace
    ? [
        ...draftWorkspace.diff.added.map((part) => ({ part, label: "Added", fields: [] as string[] })),
        ...draftWorkspace.diff.changed.map((change) => ({
          part: change.after,
          label: "Changed",
          fields: change.fields,
        })),
      ]
    : [];

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
        eyebrow="Stage 1 of 4"
        title="Sources"
        description={headerSubtitle}
        actions={workspaceReady ? (
          <PageHeaderActions>
            <Button
              className="min-h-10 w-full sm:w-auto"
              onClick={() => void onUpdateBuild()}
              disabled={selectedProfileId == null || busy || !engineReady}
              loading={busy}
            >
              {busy ? "Rebuilding…" : "Rebuild plan"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-10 w-10"
                  disabled={selectedProfileId == null || !engineReady}
                  aria-label="Plan actions"
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

      <DeskNextStep>{planNextStep}</DeskNextStep>

      {(profilesBackgroundError ||
        profileDataBackgroundError ||
        sourcesBackgroundError ||
        categoryError) && (
        <div className="space-y-1 text-sm text-destructive" role="alert">
          {profilesBackgroundError && (
            <p>Could not refresh plans: {profilesBackgroundError}</p>
          )}
          {profileDataBackgroundError && (
            <p>Could not refresh plan: {profileDataBackgroundError}</p>
          )}
          {sourcesBackgroundError && (
            <p>Could not refresh sources: {sourcesBackgroundError}</p>
          )}
          {categoryError && <p>{categoryError}</p>}
        </div>
      )}

      {workspaceReady && selectedProfileId != null && (
        <PlanSpecialRequestField
          profileId={selectedProfileId}
          value={selectedProfile?.special_request}
          className="max-w-xl"
        />
      )}

      {workspaceReady && selectedProfileId != null && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Export STLs and Share live on{" "}
          <Link
            to={exportRoute(selectedProfileId)}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Production
          </Link>
          .
        </p>
      )}

      {workspaceReady && selectedProfile && (
        <PlanFreshnessNotice
          freshness={selectedProfile.freshness}
          action={{ kind: "rebuild", busy, onRebuild: () => void onUpdateBuild() }}
        />
      )}

      {workspaceReady && draftWorkspace && (
        <Card className="border-primary/40">
          <CardHeader className="pb-2">
            <CardTitle level={3} className="text-base">Saved Plan draft</CardTitle>
            <CardDescription>
              Accepted Parts and Checkoff stay unchanged until you apply this draft.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              {draftWorkspace.diff.added.length} added, {draftWorkspace.diff.changed.length} changed, {draftWorkspace.diff.removed.length} removed
            </p>
            {(proposedPartChanges.length > 0 || draftWorkspace.diff.removed.length > 0) && (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Proposed Part</th>
                      <th className="px-3 py-2 font-medium">Change</th>
                      <th className="px-3 py-2 font-medium">Proposed qty</th>
                      <th className="px-3 py-2 font-medium">Proposed inclusion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposedPartChanges.map(({ part, label, fields }) => (
                      <tr key={`proposed-${part.draft_part_id}`} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="font-medium">{part.filename}</span>
                          <span className="block text-xs text-muted-foreground">{part.relative_path}</span>
                        </td>
                        <td className="px-3 py-2">
                          {label}{fields.length > 0 ? `: ${fields.join(", ")}` : ""}
                        </td>
                        <td className="px-3 py-2">{part.quantity_effective}</td>
                        <td className="px-3 py-2">{part.included ? "Included" : "Excluded"}</td>
                      </tr>
                    ))}
                    {draftWorkspace.diff.removed.map((part) => (
                      <tr key={`removed-${part.revision_part_id}`} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="font-medium">{part.filename}</span>
                          <span className="block text-xs text-muted-foreground">{part.relative_path}</span>
                        </td>
                        <td className="px-3 py-2">Removed</td>
                        <td className="px-3 py-2">Not applicable</td>
                        <td className="px-3 py-2">Removed</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!draftWorkspace.diff.base_is_current && (
              <p className="text-sm text-destructive" role="alert">
                The accepted Plan changed after this draft was saved. Rebase it before applying.
              </p>
            )}
            {draftWorkspace.reconciliation.kind === "unresolved" && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                <p className="text-sm">
                  Resolve {draftWorkspace.reconciliation.conflicts.length} Required-unit conflict(s) before Apply.
                </p>
                <div className="space-y-2">
                  {draftWorkspace.reconciliation.conflicts.map((conflict) => {
                    const key = `${conflict.kind}:${conflict.target_draft_part_id}`;
                    const target = draftWorkspace.parts.find(
                      (part) => part.draft_part_id === conflict.target_draft_part_id,
                    );
                    return (
                      <label key={key} className="block space-y-1 text-sm">
                        <span className="block font-medium">
                          {target?.filename ?? `Draft Part ${conflict.target_draft_part_id}`}
                        </span>
                        <select
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                          value={draftConflictChoices[key] ?? ""}
                          disabled={busy}
                          onChange={(event) => setDraftConflictChoices((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))}
                        >
                          <option value="">Choose a resolution</option>
                          {conflict.kind === "ambiguous_exact_match" && conflict.candidate_revision_part_ids.map((candidateId) => (
                            <option key={candidateId} value={String(candidateId)}>
                              Reuse {acceptedRevisionPartLabels.get(candidateId) ?? `accepted Part ${candidateId}`}
                            </option>
                          ))}
                          {conflict.kind === "unsafe_predecessor" && (
                            <option value={String(conflict.predecessor_revision_part_id)}>
                              Keep prior completed units
                            </option>
                          )}
                          <option value="replace">Print as new units</option>
                        </select>
                      </label>
                    );
                  })}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy || draftWorkspace.reconciliation.conflicts.some((conflict) => (
                      !draftConflictChoices[`${conflict.kind}:${conflict.target_draft_part_id}`]
                    ))}
                    onClick={() => void onResolveDraft()}
                  >
                    Save conflict decisions
                  </Button>
                </div>
              </div>
            )}
            {draftProductionBlock && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-sm text-destructive" role="alert">
                  {draftProductionBlock.checkoffLinkCount} checkoff record(s)
                  {draftProductionBlock.sendQueueItemCount > 0
                    ? ` and ${draftProductionBlock.sendQueueItemCount} send-queue item(s)`
                    : ""}{" "}
                  are linked to the current accepted Plan. Normal Apply is blocked to protect that progress.
                </p>
                <p className="text-sm text-muted-foreground">
                  Remap and apply moves matching checkoff records to this draft. Apply still fails if a printed file was removed or its printed count exceeds the new quantity.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => void onApplyDraft({ remapCheckoffLinks: true })}
                >
                  Remap and apply
                </Button>
              </div>
            )}
            <PlanDraftApplyButton
              workspace={draftWorkspace}
              busy={busy}
              onApply={() => void onApplyDraft()}
              onRebase={() => void onRebaseDraft()}
            />
          </CardContent>
        </Card>
      )}

      {workspaceReady && draftError && (
        <p className="text-sm text-destructive" role="alert">{draftError}</p>
      )}

      {workspaceReady && !buildStale && mergeConflicts.length > 0 && (
        <MergeConflictBanner
          conflictCount={mergeConflicts.length}
          groupedByFilename={mergeConflictGroups}
        />
      )}

      {engineState !== "ready" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Engine offline — start the print-partner engine to edit a plan."
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
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading plans…</p>
          </CardContent>
        </Card>
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={Hammer}
          title="No plan yet"
          description="Use New Build in the sidebar (or the + button on mobile) to name a Build, then attach sources and pick STL files below."
          action={{
            label: "New Build",
            onClick: openCreatePlan,
          }}
        />
      ) : selectedProfileId == null ? (
        <EmptyState
          icon={Hammer}
          title="Select a plan"
          description="Choose a plan in the sidebar plan picker (or the mobile plan switcher in the header)."
        />
      ) : sourcesState === "loading" ? (
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading sources…</p>
          </CardContent>
        </Card>
      ) : sourcesState === "error" ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
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
            <p className="text-sm text-muted-foreground">Loading plan…</p>
          </CardContent>
        </Card>
      ) : profileDataState === "error" ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive">
              Could not load plan: {profileDataError}
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
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-wide">
                Attached sources
              </h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <BuildSourcesPanel
                  profileId={selectedProfileId}
                  disabled={!engineReady || busy}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="h-7 px-2 text-xs"
                  onClick={() => setCategoriesSheetOpen(true)}
                >
                  Categories…
                </Button>
                <button
                  type="button"
                  className="text-xs font-semibold text-primary hover:underline"
                  onClick={() => setAttachOpen((v) => !v)}
                >
                  Attach another
                </button>
                <Button variant="link" className="h-auto p-0 text-xs" asChild>
                  <Link to={libraryRoute()}>Library</Link>
                </Button>
              </div>
            </div>

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
                        Pick the main kit project for this plan before adding addons or importing
                        files.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 p-4 pt-0">
                  <Combobox
                    value={pendingBaseSourceId || null}
                    onValueChange={setPendingBaseSourceId}
                    disabled={!engineReady || selectedProfileId == null}
                    placeholder="Choose base source…"
                    searchPlaceholder="Search sources…"
                    emptyText="No sources match."
                    options={baseSourceOptions}
                  />
                  <Button
                    size="sm"
                    onClick={() => void onSetBaseSource()}
                    disabled={!pendingBaseSourceId || selectedProfileId == null || !engineReady}
                  >
                    Set base source
                  </Button>
                </CardContent>
              </Card>
            )}

            <div className="flex flex-col gap-2">
              <PlanCategoryDropStrip
                categories={categories}
                onDropSourceCategory={(sourceId, category) =>
                  void assignSourceCategory(sourceId, category)
                }
              />
              {sourceCardLayers.map((row) => {
                return (
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
                    expandedExtra={
                      row.layerType === "base" ? (
                        <KitManifestOptions
                          profileId={selectedProfileId}
                          baseSourceName={row.sourceName}
                          buildStale={buildStale}
                          disabled={!engineReady || busy}
                          compact
                        />
                      ) : undefined
                    }
                    meshColorForPath={resolvePreviewMeshColor}
                  />
                );
              })}
            </div>

            {(attachOpen || addonSourceId) && (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Combobox
                  value={addonSourceId || null}
                  onValueChange={setAddonSourceId}
                  disabled={
                    !engineReady ||
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
                  className="min-h-10 w-full min-w-0 flex-1 sm:w-auto"
                  contentClassName="min-w-[16rem]"
                />
                <Button
                  size="sm"
                  className="min-h-10 w-full sm:w-auto"
                  onClick={() => {
                    void onAddAddon();
                    setAttachOpen(false);
                  }}
                  disabled={!addonSourceId || needsBaseSource}
                >
                  Attach
                </Button>
              </div>
            )}
            <div className="flex justify-end border-t border-border pt-3">
              <Button
                onClick={() => void onUpdateBuild()}
                disabled={selectedProfileId == null || busy || !engineReady}
                loading={busy}
              >
                {busy ? "Rebuilding…" : "Rebuild plan"}
              </Button>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold tracking-wide">Planning</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <PlanRolesCard
                profileId={selectedProfileId}
                disabled={!engineReady || busy}
                refreshKey={filamentRefreshKey}
                roleFilaments={roleFilaments}
                onRolesChange={setRoleFilaments}
                onUpdated={onRoleFilamentsUpdated}
              />
              <PlanWarningsCard warnings={planWarnings} />
            </div>
            <details className="group" open={partCount === 0}>
              <summary className="cursor-pointer select-none text-sm text-muted-foreground transition-colors hover:text-foreground">
                AI Build planning
              </summary>
              <div className="mt-3">
                <BuildPlanningCard planId={selectedProfileId} />
              </div>
            </details>
          </section>

          <BuildRecipePanel profileId={selectedProfileId} />
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

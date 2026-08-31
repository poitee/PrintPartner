import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ChevronDown, FolderGit2, Library, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { SourceSummary } from "@print-partner/contracts";
import { pickLocalDirectory, pickLocalFiles, pickZipArchive } from "../api/endpoints/browserFiles";
import { startSync, waitForJobDone } from "../api/endpoints/jobs";
import { startCheckSourceUpdates } from "../api/endpoints/sourceContent";
import {
  importReposTxt,
  importSourceArchive,
  importSourceFiles,
} from "../api/endpoints/sourceArtifacts";
import { startImportScan, type StlSearchHit } from "../api/endpoints/sources";
import GitHubRefField from "../components/GitHubRefField";
import { useDateFormat } from "../context/DateFormatContext";
import { useJobContext } from "../context/JobContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import EmptyState from "../components/layout/EmptyState";
import DeskNextStep from "../components/layout/DeskNextStep";
import PageHeader from "../components/layout/PageHeader";
import PageShell from "../components/layout/PageShell";
import GlobalStlSearch from "../components/sources/GlobalStlSearch";
import LibraryCategoryRail, {
  type LibraryAddKind,
} from "../components/sources/LibraryCategoryRail";
import LibrarySourceCard from "../components/sources/LibrarySourceCard";
import LibrarySourceRow from "../components/sources/LibrarySourceRow";
import BulkCategoryBar from "../components/sources/BulkCategoryBar";
import LibraryStaleBanner from "../components/sources/LibraryStaleBanner";
import SourceDetailSheet from "../components/sources/SourceDetailSheet";
import SourceCategorySheet from "../components/sources/SourceCategorySheet";
import SourceWatchPanel from "../components/sources/SourceWatchPanel";
import SourcesToolbar, {
  type SourceViewMode,
  type SyncFilter,
} from "../components/sources/SourcesToolbar";
import { kindLabel, type SourceKind } from "../components/sources/sourceLabels";
import { UNCategorized_FILTER } from "../components/sources/sourceLabels";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { useImportSharedBuild } from "../hooks/useImportSharedBuild";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "../components/ui/input-group";
import { Field, FieldLabel } from "../components/ui/field";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useJobRunner } from "../hooks/useJobRunner";
import { deskNextStepLine } from "../lib/deskNextStep";
import {
  attachedSourceIds,
  buildLibraryCardMeta,
  pickCountsBySourceId,
} from "../lib/librarySourceMeta";
import {
  countSourcesByCategory,
  reconcileSourceCategoryFilter,
  sourceCategoryLabel,
} from "../lib/sourceCategoryAssignment";
import { filterSourceLibrary } from "../lib/sourceLibraryFilters";
import { sourceSavePayloadFromDraft } from "../lib/sourceSaveDraft";
import {
  newSourceWizardDraft,
  sourceWizardDraftFromSource,
  type SourceWizardDraft,
} from "../lib/sourceWizardDraft";
import { categoryMenuOptions } from "../lib/sourceCategoryOptions";
import {
  applySelectionClick,
  isAllVisibleSelected,
  pruneSelectionToKnownIds,
  selectAllVisible,
  type SelectionModifiers,
} from "../lib/sourceSelection";
import {
  loadPersistedSourcesUi,
  savePersistedSourcesUi,
} from "../lib/persistedSourcesUi";
import { toastJobResult } from "../lib/jobToasts";
import {
  createdSourcesFromReposImport,
  formatReposImportMessage,
  formatReposSyncSummary,
  missingSourceUploadMessage,
  sourceCanUpload,
  sourceIsSyncing,
  sourceKindNeedsArchiveUpload,
  sourceSyncLabel,
} from "../lib/sourceImportModel";
import { cn } from "@/lib/utils";
import { resolveEngineState } from "../lib/workflowState";
import {
  sourceModelUrlPlaceholder,
  sourceMonitoringCapability,
  sourceMonitoringSummary,
} from "../lib/sourceMonitoring";
import {
  invalidateSourceDependents,
  useBulkAssignSourceCategoryMutation,
  useCreateSourceMutation,
  useDeleteSourceMutation,
  useSourcesQuery,
  useUpdateSourceMutation,
} from "../queries/sources";
import {
  useSaveSourceCategoriesMutation,
  useSourceCategoriesQuery,
} from "../queries/sourceCategories";
import { queryKeys } from "../queries/keys";

type SourceDetailTab = "docs" | "rules" | "naming";
type SourcesLocationState = { stlSearch?: boolean };
const EMPTY_SOURCE_CATEGORIES: string[] = [];

type WizardForm = SourceWizardDraft;

export default function SourcesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { formatDate } = useDateFormat();
  const { health, error: healthError, loading: healthLoading } = useEngineHealth();
  const { busy, runJob } = useJobRunner("sync");
  const { busy: updateBusy, runJob: runUpdateJob } =
    useJobRunner("check-source-updates");
  const { activeJobs } = useJobContext();
  const { review } = usePlanWorkspace();
  const { profiles, selectedProfileId } = useProfileSelection();
  const persistedUi = useMemo(() => loadPersistedSourcesUi(), []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<WizardForm>(newSourceWizardDraft([]));
  const [detailSourceId, setDetailSourceId] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<SourceDetailTab>("docs");
  const [highlightPath, setHighlightPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SourceSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reposImportNote, setReposImportNote] = useState<string | null>(null);
  const [reposImportOpen, setReposImportOpen] = useState(false);
  const [reposImportText, setReposImportText] = useState("");
  const [reposImportBusy, setReposImportBusy] = useState(false);
  const [reposImportSyncAfter, setReposImportSyncAfter] = useState(true);
  const [reposImportSyncNote, setReposImportSyncNote] = useState<string | null>(null);
  const [search, setSearch] = useState(persistedUi.search ?? "");
  const [categoryFilter, setCategoryFilter] = useState(persistedUi.categoryFilter);
  const [syncFilter, setSyncFilter] = useState<SyncFilter>(persistedUi.syncFilter);
  const [platformFilter, setPlatformFilter] = useState(persistedUi.platformFilter);
  const [viewMode, setViewMode] = useState<SourceViewMode>(persistedUi.viewMode);
  const searchSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stlSearchFocus, setStlSearchFocus] = useState(false);
  const [stlSearchExpanded, setStlSearchExpanded] = useState(false);
  const [categoriesSheetOpen, setCategoriesSheetOpen] = useState(false);
  const [syncingSourceIds, setSyncingSourceIds] = useState<number[] | "all" | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<number>>(new Set());
  const selectionAnchorRef = useRef<number | null>(null);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const importSharedBuild = useImportSharedBuild();
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: healthError,
  });
  const engineReady = engineState === "ready";
  const queryClient = useQueryClient();
  const {
    data: sources = [],
    isLoading: sourcesLoading,
    isFetched: sourcesLoaded,
    error: sourcesQueryError,
    refetch: refetchSources,
  } = useSourcesQuery(engineReady);
  const categoriesQuery = useSourceCategoriesQuery(engineReady);
  /** Flat, ordered category paths — "Printers" and "Printers/Frame" alike. */
  const categories = categoriesQuery.data ?? EMPTY_SOURCE_CATEGORIES;
  /** Same list as pickable options: leaf label, indent, full path as value. */
  const categoryOptions = useMemo(() => categoryMenuOptions(categories), [categories]);
  const saveCategoriesMutation = useSaveSourceCategoriesMutation();
  const createSourceMutation = useCreateSourceMutation();
  const updateSourceMutation = useUpdateSourceMutation();
  const deleteSourceMutation = useDeleteSourceMutation();
  const bulkCategoryMutation = useBulkAssignSourceCategoryMutation();
  const detailSource =
    detailSourceId == null
      ? null
      : sources.find((source) => source.id === detailSourceId) ?? null;
  const sourceQueryError =
    sourcesQueryError instanceof Error
      ? sourcesQueryError.message
      : sourcesQueryError
        ? String(sourcesQueryError)
        : null;
  const pageLoadError = loadError ?? sourceQueryError;
  const categoryError =
    categoriesQuery.error instanceof Error
      ? `Could not load source categories: ${categoriesQuery.error.message}`
      : categoriesQuery.error
        ? `Could not load source categories: ${String(categoriesQuery.error)}`
        : null;

  useEffect(() => {
    const state = location.state as SourcesLocationState | null;
    if (state?.stlSearch !== true) return;
    setStlSearchExpanded(true);
    setStlSearchFocus(true);
    void navigate(
      {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      { replace: true, state: null },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    savePersistedSourcesUi({
      viewMode,
      categoryFilter,
      syncFilter,
      platformFilter,
    });
  }, [viewMode, categoryFilter, syncFilter, platformFilter]);

  useEffect(() => {
    if (!categoriesQuery.isSuccess) return;
    const reconciled = reconcileSourceCategoryFilter(categoryFilter, categories);
    if (reconciled !== categoryFilter) setCategoryFilter(reconciled);
  }, [categories, categoriesQuery.isSuccess, categoryFilter]);

  useEffect(() => {
    if (searchSaveTimer.current) clearTimeout(searchSaveTimer.current);
    searchSaveTimer.current = setTimeout(() => {
      savePersistedSourcesUi({
        viewMode,
        categoryFilter,
        syncFilter,
        platformFilter,
        search,
      });
    }, 300);
    return () => {
      if (searchSaveTimer.current) clearTimeout(searchSaveTimer.current);
    };
  }, [search, viewMode, categoryFilter, syncFilter, platformFilter]);

  const refresh = useCallback(async () => {
    if (!engineReady) return;
    setLoadError(null);
    await Promise.allSettled([refetchSources(), categoriesQuery.refetch()]);
  }, [categoriesQuery, engineReady, refetchSources]);

  const onCategoriesReorder = useCallback(async (next: string[]) => {
    try {
      await saveCategoriesMutation.mutateAsync({ categories: next });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reorder categories");
    }
  }, [saveCategoriesMutation]);

  const filtered = useMemo(
    () =>
      filterSourceLibrary(sources, {
        search,
        categoryFilter,
        syncFilter,
        platformFilter,
      }),
    [sources, search, categoryFilter, syncFilter, platformFilter],
  );

  const visibleIds = useMemo(() => filtered.map((s) => s.id), [filtered]);

  // Drop selected ids that fall out of view (filtered away, deleted, etc.)
  // so the bulk bar never quietly acts on hidden sources.
  useEffect(() => {
    setSelectedSourceIds((prev) => {
      const pruned = pruneSelectionToKnownIds(prev, visibleIds);
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [visibleIds]);

  const onSourceSelectClick = useCallback(
    (sourceId: number, modifiers: SelectionModifiers) => {
      setSelectedSourceIds((prev) => {
        const { selection, anchorId } = applySelectionClick({
          selected: prev,
          anchorId: selectionAnchorRef.current,
          clickedId: sourceId,
          visibleIds,
          modifiers,
        });
        selectionAnchorRef.current = anchorId;
        return selection;
      });
    },
    [visibleIds],
  );

  const clearSelection = useCallback(() => {
    setSelectedSourceIds(new Set());
    selectionAnchorRef.current = null;
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelectedSourceIds(selectAllVisible(visibleIds));
  }, [visibleIds]);

  const bulkAssignCategory = async (category: string | null) => {
    const ids = Array.from(selectedSourceIds);
    if (ids.length === 0) return;
    setBulkAssigning(true);
    try {
      const result = await bulkCategoryMutation.mutateAsync({ sourceIds: ids, category });
      const label = category?.trim() ? category.trim() : "Uncategorised";
      if (result.failed > 0) {
        toast.error(
          `Moved ${result.succeeded}/${ids.length} source(s) to ${label}; ${result.failed} failed`,
        );
      } else {
        toast.success(`Moved ${result.succeeded} source(s) to ${label}`);
      }
      clearSelection();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkAssigning(false);
    }
  };

  const hasSyncedSources = sources.some((s) => Boolean(s.local_path));

  const showSourceSkeletons = sourcesLoading && !sourcesLoaded;

  const selectedPlan = profiles.find((p) => p.id === selectedProfileId) ?? null;
  const attachedIds = useMemo(() => attachedSourceIds(review), [review]);
  const pickCounts = useMemo(() => pickCountsBySourceId(review), [review]);
  const attachedCount = attachedIds.size;

  const sourcesByCategory = useMemo(
    () => countSourcesByCategory(sources),
    [sources],
  );

  const staleSources = useMemo(
    () => sources.filter((s) => s.update_status === "updates_available"),
    [sources],
  );
  const attachedStaleCount = useMemo(
    () => staleSources.filter((s) => attachedIds.has(s.id)).length,
    [staleSources, attachedIds],
  );
  const monitoring = useMemo(() => sourceMonitoringSummary(sources), [sources]);

  const syncJob = activeJobs.find(
    (j) => j.kind === "sync" && (j.status === "running" || j.status === "pending"),
  );
  const syncProgress = syncJob?.progress ?? null;

  useEffect(() => {
    if (!busy) setSyncingSourceIds(null);
  }, [busy]);

  const headerSubtitle = useMemo(() => {
    const srcLabel = `${sources.length} source${sources.length === 1 ? "" : "s"}`;
    if (!selectedPlan || attachedCount === 0) return srcLabel;
    return `${srcLabel} · ${attachedCount} attached to ${selectedPlan.name}`;
  }, [sources.length, selectedPlan, attachedCount]);

  const libraryNextStep = deskNextStepLine("library", {
    sourceCount: sources.length,
  });

  const openDetail = (
    source: SourceSummary,
    tab: SourceDetailTab = "docs",
    path: string | null = null,
  ) => {
    setDetailSourceId(source.id);
    setDetailTab(tab);
    setHighlightPath(path);
  };

  const onStlHit = (hit: StlSearchHit) => {
    const source = sources.find((s) => s.id === hit.source_id);
    if (source) openDetail(source, "rules", hit.relative_path);
  };

  const syncSources = (ids?: number[]) => {
    setSyncingSourceIds(ids && ids.length > 0 ? ids : "all");
    const label = sourceSyncLabel(ids);
    void runJob(
      () => startSync(ids),
      (snap) => {
        setSyncingSourceIds(null);
        void refresh();
        toastJobResult(snap, label, "Sync failed");
      },
    );
  };

  const checkUpdates = () => {
    void runUpdateJob(
      () => startCheckSourceUpdates(),
      (snap) => {
        void refresh();
        void queryClient.invalidateQueries({ queryKey: queryKeys.sourceActivity });
        toastJobResult(snap, "Update check finished", "Update check failed");
      },
    );
  };

  const openAddWizard = (kind?: SourceKind) => {
    setForm(newSourceWizardDraft(categories, kind));
    setEditId(null);
    setWizardOpen(true);
  };

  const onLibraryAdd = (kind: LibraryAddKind) => {
    if (kind === "plan_bundle") {
      void importSharedBuild();
      return;
    }
    if (kind === "repos_txt") {
      setReposImportOpen(true);
      return;
    }
    openAddWizard(kind);
  };

  const onSeeStaleChanges = () => {
    const first = staleSources[0];
    if (first) {
      openDetail(first, "docs");
      return;
    }
    checkUpdates();
  };

  const openEditWizard = (s: SourceSummary) => {
    setForm(sourceWizardDraftFromSource(s));
    setEditId(s.id);
    setWizardOpen(true);
  };

  const assignSourceCategory = async (
    source: SourceSummary,
    category: string | null,
  ) => {
    const previous = source.category ?? null;
    const next = category?.trim() || null;
    if (previous === next) return;
    try {
      const updated = await updateSourceMutation.mutateAsync({
        id: source.id,
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
  };

  const uploadPendingContent = async (
    sourceId: number,
    kind: SourceKind,
    pendingFiles: File[],
    pendingZip: File | null,
  ): Promise<boolean> => {
    if (kind === "local") {
      if (pendingFiles.length === 0) {
        throw new Error("Select STL files or a folder to upload.");
      }
      const result = await importSourceFiles(sourceId, pendingFiles);
      toast.success(
        `Uploaded ${result.imported_files ?? pendingFiles.length} file(s)` +
          (result.stl_count != null ? ` (${result.stl_count} STL)` : ""),
      );
      return true;
    }

    if (!sourceKindNeedsArchiveUpload(kind)) return false;

    const zip = pendingZip ?? (await pickZipArchive());
    if (!zip) {
      throw new Error(missingSourceUploadMessage(kind));
    }
    const result = await importSourceArchive(sourceId, zip);
    toast.success(
      `Uploaded archive` +
        (result.stl_count != null ? ` (${result.stl_count} STL files)` : ""),
    );
    return true;
  };

  const saveSource = async () => {
    setLoadError(null);
    try {
      const payload = sourceSavePayloadFromDraft(form);
      if (editId == null) {
        const created = await createSourceMutation.mutateAsync(payload);
        const uploaded = await uploadPendingContent(
          created.id,
          form.source_kind,
          form.pendingFiles,
          form.pendingZip,
        );
        setWizardOpen(false);
        if (uploaded) await invalidateSourceDependents(queryClient);
        if (created.source_kind === "github") syncSources([created.id]);
      } else {
        await updateSourceMutation.mutateAsync({
          id: editId,
          body: payload,
        });
        const uploaded =
          form.pendingFiles.length > 0 || form.pendingZip
            ? await uploadPendingContent(
            editId,
            form.source_kind,
            form.pendingFiles,
            form.pendingZip,
              )
            : false;
        setWizardOpen(false);
        if (uploaded) await invalidateSourceDependents(queryClient);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setLoadError(null);
    try {
      await deleteSourceMutation.mutateAsync(deleteTarget.id);
      if (detailSourceId === deleteTarget.id) setDetailSourceId(null);
      setDeleteTarget(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const syncSourceIdsSequential = async (
    entries: Array<{ source_id: number; name: string }>,
  ) => {
    const failures: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const { source_id: id, name } = entries[i];
      setReposImportSyncNote(`Syncing ${i + 1}/${entries.length}: ${name}…`);
      try {
        const jobId = await startSync([id]);
        const snap = await waitForJobDone(jobId);
        if (snap.status === "error") {
          failures.push(`${name}: ${snap.message || "sync failed"}`);
        }
      } catch (e) {
        failures.push(
          `${name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    setReposImportSyncNote(
      formatReposSyncSummary({ total: entries.length, failures }),
    );
  };

  const runReposImport = async (text: string) => {
    setReposImportBusy(true);
    setReposImportNote(null);
    setReposImportSyncNote(null);
    try {
      const result = await importReposTxt({ text });
      const importMsg = formatReposImportMessage(result);
      setReposImportNote(importMsg);
      toast.success(importMsg.trim());
      const newSources = createdSourcesFromReposImport(result);
      setReposImportOpen(false);
      setReposImportText("");
      await Promise.all([
        categoriesQuery.refetch(),
        invalidateSourceDependents(queryClient),
      ]);
      if (reposImportSyncAfter && newSources.length > 0) {
        await syncSourceIdsSequential(newSources);
        await invalidateSourceDependents(queryClient);
      }
    } catch (e) {
      setReposImportNote(e instanceof Error ? e.message : String(e));
    } finally {
      setReposImportBusy(false);
    }
  };

  const onReposFilePicked = (file: File | null) => {
    if (!file) return;
    void file.text().then((text) => {
      setReposImportText(text);
      setReposImportOpen(true);
    });
  };

  const isSourceSyncing = (sourceId: number) =>
    sourceIsSyncing({ busy, syncingSourceIds, sourceId });

  const runUpload = (s: SourceSummary) => {
    void (async () => {
      try {
        if (s.source_kind === "local") {
          const files = await pickLocalFiles();
          if (!files.length) return;
          await importSourceFiles(s.id, files);
        } else {
          const zip = await pickZipArchive();
          if (!zip) return;
          await importSourceArchive(s.id, zip);
        }
        await refresh();
        toast.success("Upload complete");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const renderSourceCard = (s: SourceSummary) => {
    const syncing = isSourceSyncing(s.id);
    const meta = buildLibraryCardMeta({
      source: s,
      attached: attachedIds.has(s.id),
      pickCount: attachedIds.has(s.id) ? (pickCounts.get(s.id) ?? 0) : null,
      syncing,
      syncProgress: syncing ? syncProgress : null,
      formatDate,
    });
    return (
      <LibrarySourceCard
        key={s.id}
        source={s}
        meta={meta}
        categories={categories}
        busy={busy}
        onOpen={() => openDetail(s, "docs")}
        onEdit={() => openEditWizard(s)}
        onSync={
          sourceMonitoringCapability(s.source_kind) === "automatic"
            ? () => syncSources([s.id])
            : undefined
        }
        onUpload={sourceCanUpload(s) ? () => runUpload(s) : undefined}
        onDelete={() => setDeleteTarget(s)}
        onAssignCategory={(category) => void assignSourceCategory(s, category)}
        selected={selectedSourceIds.has(s.id)}
        onSelectClick={(mods) => onSourceSelectClick(s.id, mods)}
      />
    );
  };

  const renderSourceRow = (s: SourceSummary) => {
    const syncing = isSourceSyncing(s.id);
    const isSelected = selectedSourceIds.has(s.id);
    const meta = buildLibraryCardMeta({
      source: s,
      attached: attachedIds.has(s.id),
      pickCount: attachedIds.has(s.id) ? (pickCounts.get(s.id) ?? 0) : null,
      syncing,
      syncProgress: syncing ? syncProgress : null,
      formatDate,
    });
    return (
      <LibrarySourceRow
        key={s.id}
        source={s}
        meta={meta}
        categories={categories}
        busy={busy}
        selected={isSelected}
        onOpen={() => openDetail(s, "docs")}
        onEdit={() => openEditWizard(s)}
        onSync={
          sourceMonitoringCapability(s.source_kind) === "automatic"
            ? () => syncSources([s.id])
            : undefined
        }
        onUpload={sourceCanUpload(s) ? () => runUpload(s) : undefined}
        onDelete={() => setDeleteTarget(s)}
        onAssignCategory={(category) => void assignSourceCategory(s, category)}
        onSelectClick={(mods) => onSourceSelectClick(s.id, mods)}
      />
    );
  };

  if (!engineReady) {
    return (
      <PageShell>
        <PageHeader icon={Library} accent eyebrow="Workshop" title="Source Library" />
        <Card>
          <CardContent className="pt-6">
            <p
              className="text-sm text-muted-foreground"
              role={engineState === "offline" ? "alert" : "status"}
            >
              {engineState === "offline"
                ? "Engine offline — start the print-partner engine to use Library."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 sm:max-w-[230px] sm:flex-none"
            onClick={() => {
              setStlSearchExpanded(true);
              setStlSearchFocus(true);
            }}
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">Search STLs everywhere</span>
            <kbd className="ml-auto hidden font-mono text-3xs text-muted-foreground sm:inline">
              ⌘K
            </kbd>
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="min-h-9" disabled={!engineReady}>
                Add source
                <ChevronDown className="ml-1.5 h-3.5 w-3.5 opacity-80" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openAddWizard("github")}>
                GitHub repo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openAddWizard("local")}>
                Local folder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openAddWizard("archive")}>
                Zip upload
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openAddWizard("printables")}>
                Printables
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openAddWizard("makerworld")}>
                MakerWorld
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openAddWizard("thangs")}>
                Thangs
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openAddWizard("self")}>
                Another instance / URL
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void importSharedBuild()}>
                Plan bundle…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="min-h-9" disabled={!engineReady}>
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => void refresh()}
                disabled={busy || updateBusy}
              >
                Refresh list
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setReposImportOpen(true)}>
                Import repos.txt…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  document.getElementById("repos-txt-file-input")?.click();
                }}
              >
                Choose repos.txt file…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCategoriesSheetOpen(true)}>
                Manage categories…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
    </div>
  );

  return (
    <div className={cn("space-y-4", detailSource != null && "lg:pl-[min(42rem,100%)]")}>
      <PageHeader
        icon={Library}
        accent
        eyebrow="Workshop"
        title="Source Library"
        description={`${headerSubtitle} · Add, sync, and watch reusable print projects.`}
        actions={headerActions}
      />
      <DeskNextStep>{libraryNextStep}</DeskNextStep>

      <SourceWatchPanel
        githubSourceCount={monitoring.automaticCount}
        manualTrackedCount={monitoring.manualTrackedCount}
        updateCount={monitoring.updateCount}
        attachedUpdateCount={attachedStaleCount}
        lastCheckedAt={monitoring.lastCheckedAt}
        checking={updateBusy}
        syncing={busy}
        onCheckNow={checkUpdates}
        onSyncGitHub={() =>
          syncSources(
            sources
              .filter(
                (source) => sourceMonitoringCapability(source.source_kind) === "automatic",
              )
              .map((source) => source.id),
          )
        }
        onShowUpdates={() => setSyncFilter("updates")}
        onImportRepositories={() => setReposImportOpen(true)}
      />

      <div className="overflow-hidden rounded-xl border border-border bg-card lg:grid lg:min-h-[min(70vh,720px)] lg:grid-cols-[178px_minmax(0,1fr)]">
        <LibraryCategoryRail
          className="hidden lg:flex"
          categories={categories}
          sourcesByCategory={sourcesByCategory}
          totalCount={sources.length}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          onManageCategories={() => setCategoriesSheetOpen(true)}
          onCategoriesReorder={(next) => void onCategoriesReorder(next)}
          onDropSourceCategory={(sourceId, category) => {
            const source = sources.find((s) => s.id === sourceId);
            if (source) void assignSourceCategory(source, category);
          }}
          onAddSource={onLibraryAdd}
        />

        <div className="flex min-w-0 flex-col">

          <div className="flex flex-1 flex-col gap-3 overflow-auto p-3.5 sm:px-5 sm:py-3.5">
            {(stlSearchExpanded || stlSearchFocus) && (
              <GlobalStlSearch
                engineReady={engineReady}
                hasSyncedSources={hasSyncedSources}
                onSelectHit={onStlHit}
                autoFocus={stlSearchFocus}
              />
            )}

            {/* Mobile category chips when side rail is hidden */}
            <div className="flex gap-1.5 overflow-x-auto lg:hidden [-webkit-overflow-scrolling:touch]">
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                variant={categoryFilter === "all" ? "secondary" : "ghost"}
                onClick={() => setCategoryFilter("all")}
              >
                All ({sources.length})
              </Button>
              {categoryOptions.map((option) => (
                <Button
                  key={option.path}
                  type="button"
                  size="sm"
                  className="shrink-0"
                  variant={categoryFilter === option.path ? "secondary" : "ghost"}
                  onClick={() => setCategoryFilter(option.path)}
                  title={option.path}
                >
                  {option.parentLabel ? `${option.parentLabel} › ${option.label}` : option.label}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                variant={categoryFilter === UNCategorized_FILTER ? "secondary" : "ghost"}
                onClick={() => setCategoryFilter(UNCategorized_FILTER)}
              >
                Uncategorised
              </Button>
            </div>

            <LibraryStaleBanner
              staleCount={staleSources.length}
              attachedStaleCount={attachedStaleCount}
              onSeeChanges={onSeeStaleChanges}
            />

            <BulkCategoryBar
              count={selectedSourceIds.size}
              categories={categories}
              busy={bulkAssigning}
              onAssign={(category) => void bulkAssignCategory(category)}
              onSelectAll={selectAllFiltered}
              allSelected={isAllVisibleSelected(selectedSourceIds, visibleIds)}
              onClear={clearSelection}
            />

            <SourcesToolbar
              search={search}
              onSearchChange={setSearch}
              categoryFilter={categoryFilter}
              onCategoryFilterChange={setCategoryFilter}
              categories={categories}
              syncFilter={syncFilter}
              onSyncFilterChange={setSyncFilter}
              platformFilter={platformFilter}
              onPlatformFilterChange={setPlatformFilter}
              sources={sources}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onManageCategories={() => setCategoriesSheetOpen(true)}
              hideCategoryPills
            />

            {(pageLoadError || categoryError || reposImportNote || reposImportSyncNote) && (
              <div
                className="space-y-1 text-sm"
                role={pageLoadError || categoryError ? "alert" : undefined}
              >
                {pageLoadError && <p className="text-destructive">{pageLoadError}</p>}
                {categoryError && <p className="text-destructive">{categoryError}</p>}
                {reposImportNote && <p className="text-muted-foreground">{reposImportNote}</p>}
                {reposImportSyncNote && (
                  <p className="text-muted-foreground">{reposImportSyncNote}</p>
                )}
              </div>
            )}

            {showSourceSkeletons ? (
              viewMode === "grid" ? (
                <div
                  className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                  role="status"
                  aria-label="Loading Source Library"
                >
                  {Array.from({ length: 6 }, (_, i) => (
                    <div
                      key={i}
                      className="overflow-hidden rounded-lg border border-border bg-card"
                    >
                      <Skeleton className="h-16 w-full rounded-none" />
                      <div className="space-y-2 p-3">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-3 w-1/2" />
                        <Skeleton className="h-1 w-full" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="space-y-2"
                  role="status"
                  aria-label="Loading Source Library"
                >
                  {Array.from({ length: 6 }, (_, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                    >
                      <div className="min-w-0 flex-1 space-y-2">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                      <Skeleton className="h-5 w-20" />
                      <Skeleton className="h-8 w-16" />
                    </div>
                  ))}
                </div>
              )
            ) : pageLoadError && sources.length === 0 ? (
              <Card className="border-destructive/40 bg-destructive/5 shadow-none">
                <CardContent className="space-y-3 pt-6">
                  <p className="text-sm text-destructive">
                    Could not load Library: {pageLoadError}
                  </p>
                  <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                    Retry
                  </Button>
                </CardContent>
              </Card>
            ) : sources.length === 0 ? (
              <EmptyState
                icon={FolderGit2}
                title="No sources yet"
                description="Add a source to start the desk loop."
                action={{ label: "Add source", onClick: () => openAddWizard() }}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={FolderGit2}
                title="No sources match"
                description="Try clearing filters or search terms."
                action={{
                  label: "Clear filters",
                  onClick: () => {
                    setSearch("");
                    setCategoryFilter("all");
                    setSyncFilter("all");
                    setPlatformFilter("all");
                  },
                }}
              />
            ) : viewMode === "grid" ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map(renderSourceCard)}
              </div>
            ) : (
              <div className="space-y-2">{filtered.map(renderSourceRow)}</div>
            )}
          </div>
        </div>
      </div>

      <input
        id="repos-txt-file-input"
        type="file"
        accept=".txt,text/plain"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => onReposFilePicked(e.target.files?.[0] ?? null)}
      />

      <Dialog open={reposImportOpen} onOpenChange={setReposImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import repos.txt</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            One repo per line: <code className="font-mono">name,url,branch</code> or a GitHub URL.
          </p>
          <textarea
            aria-label="Repository list"
            className="min-h-40 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            value={reposImportText}
            onChange={(e) => setReposImportText(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={reposImportSyncAfter}
              onChange={(e) => setReposImportSyncAfter(e.target.checked)}
              disabled={reposImportBusy}
            />
            Sync after import (new GitHub sources only)
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReposImportOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={reposImportBusy || !reposImportText.trim()}
              onClick={() => void runReposImport(reposImportText)}
            >
              {reposImportBusy ? "Importing…" : "Import"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId == null ? "Add source" : "Edit source"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="source-name">Name</Label>
              <Input
                id="source-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="source-platform">Platform</Label>
              <Select
                value={form.source_kind}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, source_kind: v as SourceKind }))
                }
              >
                <SelectTrigger id="source-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      "github",
                      "local",
                      "printables",
                      "makerworld",
                      "thangs",
                      "self",
                      "archive",
                    ] as SourceKind[]
                  ).map((k) => (
                    <SelectItem key={k} value={k}>
                      {kindLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="source-category">Category</Label>
              <Select
                value={form.category || UNCategorized_FILTER}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    category: v === UNCategorized_FILTER ? "" : v,
                  }))
                }
              >
                <SelectTrigger id="source-category">
                  <SelectValue placeholder={sourceCategoryLabel(null)} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNCategorized_FILTER}>
                    {sourceCategoryLabel(null)}
                  </SelectItem>
                  {categoryOptions.map((option) => (
                    <SelectItem
                      key={option.path}
                      value={option.path}
                      style={option.indentStyle}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.source_kind === "local" ? (
              <div className="space-y-2 md:col-span-2">
                <Label>STL files</Label>
                <p className="text-xs text-muted-foreground">
                  Files upload to the server when you save. Pick a folder or select multiple
                  STL files from your computer.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={async () => {
                      const files = await pickLocalDirectory();
                      if (files.length > 0) {
                        setForm((f) => ({ ...f, pendingFiles: files, pendingZip: null }));
                      }
                    }}
                  >
                    Browse folder…
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={async () => {
                      const files = await pickLocalFiles();
                      if (files.length > 0) {
                        setForm((f) => ({
                          ...f,
                          pendingFiles: [...f.pendingFiles, ...files],
                          pendingZip: null,
                        }));
                      }
                    }}
                  >
                    Add STL files…
                  </Button>
                  {form.pendingFiles.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setForm((f) => ({ ...f, pendingFiles: [] }))}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                {form.pendingFiles.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {form.pendingFiles.length} file
                    {form.pendingFiles.length === 1 ? "" : "s"} selected
                  </p>
                )}
              </div>
            ) : form.source_kind === "archive" ? (
              <div className="space-y-2 md:col-span-2">
                <Label>ZIP archive</Label>
                <p className="text-xs text-muted-foreground">
                  Upload a ZIP containing STL files when you save.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={async () => {
                      const zip = await pickZipArchive();
                      if (zip) setForm((f) => ({ ...f, pendingZip: zip, pendingFiles: [] }));
                    }}
                  >
                    {form.pendingZip ? "Change ZIP…" : "Choose ZIP…"}
                  </Button>
                  {form.pendingZip && (
                    <span className="truncate text-xs text-muted-foreground">
                      {form.pendingZip.name}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-1 md:col-span-2">
                  <Field>
                    <FieldLabel htmlFor="source-url">URL</FieldLabel>
                    <InputGroup className="mt-1">
                      <InputGroupAddon align="inline-start">
                        <InputGroupText>
                          {(form.url.match(/^(https?):\/\//i)?.[1]?.toLowerCase() ===
                          "http"
                            ? "http"
                            : "https") + "://"}
                        </InputGroupText>
                      </InputGroupAddon>
                      <InputGroupInput
                        id="source-url"
                        value={form.url.replace(/^https?:\/\//i, "")}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          if (!raw) {
                            setForm((f) => ({ ...f, url: "" }));
                            return;
                          }
                          if (/^https?:\/\//i.test(raw)) {
                            setForm((f) => ({ ...f, url: raw }));
                            return;
                          }
                          const existing = form.url.match(/^(https?):\/\//i)?.[1];
                          const scheme =
                            existing?.toLowerCase() === "http" ? "http" : "https";
                          setForm((f) => ({ ...f, url: `${scheme}://${raw}` }));
                        }}
                        placeholder={sourceModelUrlPlaceholder(form.source_kind)}
                      />
                    </InputGroup>
                  </Field>
                </div>
                {(form.source_kind === "printables" ||
                  form.source_kind === "makerworld" ||
                  form.source_kind === "thangs") && (
                  <div className="space-y-2 md:col-span-2">
                    <Label>Model archive (ZIP)</Label>
                    <p className="text-xs text-muted-foreground">
                      Download the model archive from the site, then attach it here. The web app
                      uploads the ZIP to your server. Automatic file refresh is currently limited
                      to GitHub repositories.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={async () => {
                          const zip = await pickZipArchive();
                          if (zip) setForm((f) => ({ ...f, pendingZip: zip, pendingFiles: [] }));
                        }}
                      >
                        {form.pendingZip ? "Change ZIP…" : "Choose ZIP…"}
                      </Button>
                      {form.pendingZip && (
                        <span className="truncate text-xs text-muted-foreground">
                          {form.pendingZip.name}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {form.source_kind === "github" && (
                  <GitHubRefField
                    url={form.url}
                    refType={form.refType}
                    branch={form.branch}
                    tag={form.tag}
                    onRefTypeChange={(refType) => setForm((f) => ({ ...f, refType }))}
                    onBranchChange={(branch) => setForm((f) => ({ ...f, branch }))}
                    onTagChange={(tag) => setForm((f) => ({ ...f, tag }))}
                  />
                )}
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            {loadError && wizardOpen && (
              <p className="mr-auto self-center text-sm text-destructive">{loadError}</p>
            )}
            <Button variant="ghost" onClick={() => setWizardOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveSource()}>Save</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove source?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleteTarget
              ? `“${deleteTarget.name}” will be removed from Print Partner. Synced files on disk are not deleted.`
              : ""}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="ghost" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? "Removing…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <SourceCategorySheet
        open={categoriesSheetOpen}
        onOpenChange={setCategoriesSheetOpen}
        engineReady={engineReady}
      />

      <SourceDetailSheet
        source={detailSource}
        open={detailSource != null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailSourceId(null);
            setHighlightPath(null);
          }
        }}
        initialTab={detailTab}
        highlightPath={highlightPath}
        busy={busy}
        categories={categories}
        onEdit={openEditWizard}
        onDelete={setDeleteTarget}
        onAssignCategory={(source, category) =>
          void assignSourceCategory(source, category)
        }
        onSaveRules={() => {}}
        runImportScan={(sourceId) => {
          void runJob(
            () => startImportScan(sourceId),
            () => {},
          );
        }}
      />
    </div>
  );
}

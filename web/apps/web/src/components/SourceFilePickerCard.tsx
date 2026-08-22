import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import ImportRulesTree from "./ImportRulesTree";
const Preview3D = lazy(() => import("./Preview3D"));
import PartPreviewDialog from "./parts/PartPreviewDialog";
import SourceCardCover from "./SourceCardCover";
import SourceDocsSheet from "./sources/SourceDocsSheet";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import { fetchStlTree, type SourceSummary } from "../api/engine";
import { useDateFormat } from "../context/DateFormatContext";
import { useJobContext } from "../context/JobContext";
import { useImportRulesAutosave } from "../hooks/useImportRulesAutosave";
import { useImportRulesSaveRegistry } from "../context/ImportRulesSaveContext";
import {
  importRulesSaveStatusLabel,
  shouldShowImportRulesRetry,
} from "../lib/importRulesSave";
import { librarySourceDragId } from "../lib/sourceCategoryDnD";
import { cn } from "../lib/utils";

type Props = {
  sourceId: number;
  sourceName: string;
  layerType: "base" | "addon";
  source?: SourceSummary | null;
  allSources?: SourceSummary[];
  disabled?: boolean;
  defaultExpanded?: boolean;
  onChangeSource?: (projectId: number) => void;
  onRemove?: () => void;
  /** Shown inside expanded card (e.g. kit manifest variants for base layer). */
  expandedExtra?: ReactNode;
  /** Resolve mesh color from the selected STL path (role filament defaults). */
  meshColorForPath?: (relativePath: string) => string | undefined;
  /** Assign this source to a category (Plan compose). */
  onAssignCategory?: (category: string | null) => void;
};

function attachedStateLabel(
  source: SourceSummary | null | undefined,
  formatDate: (iso: string | null | undefined) => string,
  selectedCount: number,
  totalFiles: number,
  syncing: boolean,
  syncMessage: string,
): { text: string; tone: "muted" | "warn" | "sync" } {
  if (syncing) {
    return { text: syncMessage || "syncing", tone: "sync" };
  }
  if (source?.update_status === "updates_available") {
    return { text: "update available", tone: "warn" };
  }
  if (source?.source_kind === "local") {
    const picks =
      totalFiles > 0 ? ` · ${selectedCount} of ${totalFiles} files` : selectedCount > 0 ? ` · ${selectedCount} picks` : "";
    return { text: `local folder · always current${picks}`, tone: "muted" };
  }
  if (!source?.last_synced_at) {
    return { text: "not synced", tone: "warn" };
  }
  const formatted = formatDate(source.last_synced_at);
  const syncBit = formatted ? `synced ${formatted}` : "synced";
  const picks =
    totalFiles > 0
      ? ` · ${selectedCount} of ${totalFiles} files`
      : selectedCount > 0
        ? ` · ${selectedCount} picks`
        : "";
  return { text: `${syncBit}${picks}`, tone: "muted" };
}

export default function SourceFilePickerCard({
  sourceId,
  sourceName,
  layerType,
  source,
  allSources,
  disabled = false,
  defaultExpanded = false,
  onChangeSource,
  onRemove,
  expandedExtra,
  meshColorForPath,
  onAssignCategory,
}: Props) {
  const { formatDate } = useDateFormat();
  const { activeJobs } = useJobContext();
  const expandedKey = `pp-build-source-${sourceId}-expanded`;
  const [expanded, setExpanded] = useState(() => {
    try {
      const stored = sessionStorage.getItem(expandedKey);
      if (stored === "0" || stored === "1") return stored === "1";
    } catch {
      /* ignore */
    }
    return defaultExpanded;
  });
  const [savedRules, setSavedRules] = useState<string[]>([]);
  const [pendingRules, setPendingRules] = useState<string[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [userEditedRules, setUserEditedRules] = useState(false);
  const userEditedRulesRef = useRef(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [duplicateBasenames, setDuplicateBasenames] = useState<string[]>([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const activeSync = activeJobs.find(
    (j) =>
      j.kind === "sync" &&
      (j.status === "pending" || j.status === "running") &&
      (j.sourceIds == null || j.sourceIds.includes(sourceId)),
  );
  const syncBusy = Boolean(activeSync);
  const syncProgress =
    typeof activeSync?.progress === "number" && activeSync.progress >= 0
      ? Math.min(100, Math.round(activeSync.progress * (activeSync.progress <= 1 ? 100 : 1)))
      : null;

  const onSaved = useCallback(
    (rules: string[]) => {
      setSavedRules(rules);
      setPendingRules(rules);
      setUserEditedRules(false);
      userEditedRulesRef.current = false;
    },
    [],
  );

  const loadSelectionSummary = useCallback(async () => {
    if (!source?.local_path) return;
    try {
      const tree = await fetchStlTree(sourceId);
      setSelectedCount(tree.selected);
      setTotalFiles(tree.total);
    } catch {
      /* tree unavailable until sync */
    }
  }, [source?.local_path, sourceId]);

  const onSavedWithRefresh = useCallback(
    (rules: string[]) => {
      onSaved(rules);
      void loadSelectionSummary();
    },
    [loadSelectionSummary, onSaved],
  );

  const { registerFlush, unregisterFlush } = useImportRulesSaveRegistry();

  const { dirty, status, saveNow, saveUserEdit } = useImportRulesAutosave({
    sourceId,
    pendingRules,
    savedRules,
    rulesLoaded,
    userEdited: userEditedRules,
    disabled,
    onSaved: onSavedWithRefresh,
    onRegisterFlush: registerFlush,
    onUnregisterFlush: unregisterFlush,
  });

  const onPendingRulesChange = useCallback(
    (rules: string[], opts?: { userInitiated?: boolean }) => {
      if (opts?.userInitiated) {
        setPendingRules(rules);
        setUserEditedRules(true);
        userEditedRulesRef.current = true;
        saveUserEdit(rules);
        return;
      }
      if (!userEditedRulesRef.current) {
        setPendingRules(rules);
        setSavedRules(rules);
        setRulesLoaded(true);
      }
    },
    [saveUserEdit],
  );

  const saveStatusLabel = importRulesSaveStatusLabel(status);
  const showRetry = shouldShowImportRulesRetry(status);

  useEffect(() => {
    userEditedRulesRef.current = false;
    setRulesLoaded(false);
    setUserEditedRules(false);
    setPendingRules([]);
    setSavedRules([]);
    setSelectedCount(0);
    setTotalFiles(0);
  }, [sourceId]);

  useEffect(() => {
    void loadSelectionSummary();
  }, [loadSelectionSummary]);

  useEffect(() => {
    if (!expanded) setSelectedFilePath(null);
  }, [expanded]);

  useEffect(() => {
    try {
      sessionStorage.setItem(expandedKey, expanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [expanded, expandedKey]);

  const previewFilename = useMemo(() => {
    if (!selectedFilePath) return undefined;
    const parts = selectedFilePath.split("/");
    return parts[parts.length - 1] || selectedFilePath;
  }, [selectedFilePath]);

  const previewMeshColor = useMemo(() => {
    if (!selectedFilePath || !meshColorForPath) return undefined;
    return meshColorForPath(selectedFilePath);
  }, [selectedFilePath, meshColorForPath]);

  const state = attachedStateLabel(
    source,
    formatDate,
    selectedCount,
    totalFiles,
    syncBusy,
    activeSync?.message ?? "syncing",
  );
  const updateWarn = source?.update_status === "updates_available" || !source?.last_synced_at;
  const pickLabel =
    selectedCount > 0 ? String(selectedCount) : totalFiles > 0 ? "0" : "—";

  return (
    <div
      draggable={!disabled}
      onDragStart={(e) => {
        // Don't start a source drag from interactive controls inside the card.
        const target = e.target as HTMLElement | null;
        if (target?.closest("input,button,select,textarea,a,[data-no-source-drag]")) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("text/plain", librarySourceDragId(sourceId));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border bg-card px-3.5 py-2.5 shadow-[0_1px_2px_rgba(89,115,166,0.06)]",
        updateWarn || syncBusy
          ? syncBusy
            ? "border-sky-300/80 dark:border-sky-700/50"
            : "border-amber-300/80 dark:border-amber-700/50"
          : "border-border",
        expanded && dirty && "border-primary/40",
        !disabled && "cursor-grab active:cursor-grabbing",
      )}
      title={onAssignCategory ? "Drag onto a category" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2.5 sm:flex-nowrap">
        <SourceCardCover
          sourceId={sourceId}
          name={sourceName}
          sourceKind={source?.source_kind ?? "github"}
          thumb
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={layerType} className="h-5 px-1.5 text-[10px]">
              {layerType}
            </Badge>
            <h2 className="truncate text-[13px] font-semibold">{sourceName}</h2>
            {source ? (
              <span className="truncate text-[11px] text-muted-foreground">
                {source.category?.trim() || "Uncategorised"}
              </span>
            ) : null}
            {saveStatusLabel && (
              <span
                className={cn(
                  "text-[10px] font-medium",
                  status === "saved" && "text-emerald-600 dark:text-emerald-400",
                  status === "error" && "text-destructive",
                  (status === "pending" || status === "saving") && "text-muted-foreground",
                )}
                aria-live="polite"
              >
                {saveStatusLabel}
              </span>
            )}
          </div>
          <p
            className={cn(
              "font-mono text-[10.5px] font-normal",
              state.tone === "warn" && "text-amber-700 dark:text-amber-400",
              state.tone === "sync" && "text-sky-700 dark:text-sky-400",
              state.tone === "muted" && "text-muted-foreground",
            )}
          >
            {state.text}
          </p>
        </div>
        <div className="ml-auto flex w-full flex-wrap items-center gap-3 sm:w-auto sm:flex-nowrap">
          <span className="font-mono text-[11.5px] font-medium tabular-nums">{pickLabel}</span>
          {(source?.local_path || source?.source_kind === "github") && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={() => setDocsOpen(true)}
            >
              Docs
            </button>
          )}
          {source?.local_path && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={() => setRulesOpen(true)}
            >
              Rules
            </button>
          )}
          <button
            type="button"
            className="text-xs font-semibold text-primary hover:underline"
            disabled={disabled}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Hide picks" : "Edit picks"}
          </button>
          {allSources && onChangeSource && (
            <select
              className="max-w-[140px] rounded-md border border-input bg-background px-1.5 py-1 text-[11px]"
              value={sourceId}
              disabled={disabled}
              aria-label={`Change ${layerType} source`}
              onChange={(e) => {
                const pid = Number(e.target.value);
                if (pid && pid !== sourceId) onChangeSource(pid);
              }}
            >
              {allSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {layerType === "addon" && onRemove && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-destructive"
              disabled={disabled}
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {syncBusy && (
        <div className="flex items-center gap-2">
          <span className="block h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full bg-sky-600 transition-[width] dark:bg-sky-400"
              style={{ width: `${syncProgress ?? 56}%` }}
            />
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-sky-700 dark:text-sky-400">
            {activeSync?.message || "syncing"}
          </span>
        </div>
      )}

      {source?.local_path && expanded && (
        <div className="space-y-3 border-t border-border pt-3">
          {expandedExtra}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Check STL files or folders to include on the next{" "}
              <strong className="font-medium text-foreground">Rebuild plan</strong>. Selections
              save automatically.
            </p>
            {showRetry && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={disabled}
                onClick={() => void saveNow()}
              >
                Retry save
              </Button>
            )}
          </div>
          {duplicateBasenames.length > 0 && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">Duplicate filenames selected</strong>
              {" — "}
              {duplicateBasenames.slice(0, 4).join(", ")}
              {duplicateBasenames.length > 4
                ? ` (+${duplicateBasenames.length - 4} more)`
                : ""}
              . Overlapping import rules may cause merge conflicts — narrow rules or exclude extras
              on Parts after rebuild.
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,320px)]">
            {!rulesOpen && (
              <ImportRulesTree
                key={sourceId}
                projectId={sourceId}
                variant="inline"
                disabled={disabled}
                selectedFilePath={selectedFilePath}
                onFileSelect={setSelectedFilePath}
                onRulesChange={onPendingRulesChange}
                enableFileCategoryDrag={Boolean(onAssignCategory)}
                onSelectionStats={(selected, total, duplicates) => {
                  setSelectedCount(selected);
                  setTotalFiles(total);
                  setDuplicateBasenames(duplicates);
                }}
              />
            )}
            <aside className="relative rounded-md border border-border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground">STL preview</h3>
                {selectedFilePath && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                    aria-label="Open larger preview"
                    onClick={() => setPreviewOpen(true)}
                  >
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                    Expand
                  </Button>
                )}
              </div>
              <Suspense fallback={<div className="flex items-center justify-center min-h-[220px]">Loading 3D…</div>}>
                <Preview3D
                  partId={null}
                  sourceId={sourceId}
                  relativePath={selectedFilePath}
                  preferSource
                  filename={previewFilename}
                  meshColor={previewMeshColor}
                  className="min-h-[220px]"
                  instructions="sr-only"
                />
              </Suspense>
            </aside>
          </div>
        </div>
      )}

      <SourceDocsSheet
        sourceId={sourceId}
        sourceName={sourceName}
        open={docsOpen}
        onOpenChange={setDocsOpen}
      />

      <Sheet open={rulesOpen} onOpenChange={setRulesOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Import rules · {sourceName}</SheetTitle>
            <SheetDescription>
              Choose which folders and STL files are included in this plan.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            {source?.local_path ? (
              <ImportRulesTree
                key={`rules-sheet-${sourceId}`}
                projectId={sourceId}
                variant="inline"
                disabled={disabled}
                onRulesChange={onPendingRulesChange}
                onSelectionStats={(selected, total, duplicates) => {
                  setSelectedCount(selected);
                  setTotalFiles(total);
                  setDuplicateBasenames(duplicates);
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Sync this source before editing rules.</p>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <PartPreviewDialog
        part={
          previewOpen && selectedFilePath
            ? {
                sourceId,
                relativePath: selectedFilePath,
                filename: previewFilename ?? selectedFilePath,
                filament_hex: previewMeshColor,
                preferSource: true,
              }
            : null
        }
        size="large"
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  );
}

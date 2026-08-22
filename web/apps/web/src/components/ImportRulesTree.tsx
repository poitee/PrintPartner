import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  collectCheckedFiles,
  collectVisibleFilePaths,
  compressRulesFromClientTree,
  fetchStlTree,
  folderCheckState,
  nodeMatchesFilter,
  refreshFolderStates,
  setAllChecked,
  setFileChecked,
  setFilesChecked,
  setFolderChecked,
  sortTreeNodes,
  type ImportRulesSort,
  type StlTreeNode,
} from "../api/importRulesTree";
import { suggestRulesFromTopLevelFolders } from "../lib/importRulesSuggest";
import { findDuplicateBasenames } from "../lib/importRuleConflicts";
import { libraryFileDragId } from "../lib/sourceCategoryDnD";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

type Props = {
  projectId: number;
  onRulesChange: (rules: string[], opts?: { userInitiated?: boolean }) => void;
  disabled?: boolean;
  variant?: "default" | "inline";
  selectedFilePath?: string | null;
  onFileSelect?: (path: string | null) => void;
  onSelectionStats?: (selected: number, total: number, duplicateBasenames: string[]) => void;
  className?: string;
  /** When set, files are draggable onto category drop targets (assigns this source). */
  enableFileCategoryDrag?: boolean;
};

function TreeRows({
  nodes,
  depth,
  filter,
  sortBy,
  onToggleFolder,
  onToggleFile,
  onFileSelect,
  selectedFilePath,
  disabled,
  variant,
  collapsedFolders,
  onToggleFolderExpand,
  projectId,
  enableFileCategoryDrag,
}: {
  nodes: StlTreeNode[];
  depth: number;
  filter: string;
  sortBy: ImportRulesSort;
  onToggleFolder: (path: string, checked: boolean) => void;
  onToggleFile: (path: string, checked: boolean) => void;
  onFileSelect?: (path: string) => void;
  selectedFilePath?: string | null;
  disabled?: boolean;
  variant: "default" | "inline";
  collapsedFolders: Set<string>;
  onToggleFolderExpand: (path: string) => void;
  projectId: number;
  enableFileCategoryDrag?: boolean;
}) {
  const needle = filter.trim().toLowerCase();
  const displayNodes = useMemo(() => sortTreeNodes(nodes, sortBy), [nodes, sortBy]);
  const inline = variant === "inline";

  return (
    <>
      {displayNodes.map((node) => {
        if (!nodeMatchesFilter(node, needle)) return null;
        if (node.kind === "file") {
          const fileName = node.name || node.path.split("/").pop() || node.path;
          const isSelected = selectedFilePath === node.path;
          if (inline) {
            return (
              <li
                key={node.path}
                draggable={Boolean(enableFileCategoryDrag) && !disabled}
                onDragStart={(e) => {
                  if (!enableFileCategoryDrag) return;
                  e.stopPropagation();
                  e.dataTransfer.setData(
                    "text/plain",
                    libraryFileDragId(projectId, node.path),
                  );
                  e.dataTransfer.effectAllowed = "move";
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md py-0.5 pr-1 text-sm transition-colors",
                  isSelected && "bg-primary/10 ring-1 ring-primary/30",
                  !node.checked && "opacity-70",
                  enableFileCategoryDrag && !disabled && "cursor-grab active:cursor-grabbing",
                )}
                style={{ paddingLeft: `${depth * 0.9}rem` }}
                title={enableFileCategoryDrag ? "Drag onto a category" : undefined}
              >
                <input
                  type="checkbox"
                  checked={node.checked}
                  disabled={disabled}
                  aria-label={`Include ${fileName}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onToggleFile(node.path, e.target.checked)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  disabled={disabled}
                  onClick={() => onFileSelect?.(node.path)}
                >
                  <span className="font-mono text-xs">{node.path}</span>
                </button>
              </li>
            );
          }
          return (
            <li key={node.path} className="tree-file" style={{ paddingLeft: `${depth * 1.1}rem` }}>
              <label>
                <input
                  type="checkbox"
                  checked={node.checked}
                  disabled={disabled}
                  onChange={(e) => onToggleFile(node.path, e.target.checked)}
                />
                <span className="mono">{node.path}</span>
              </label>
            </li>
          );
        }

        const state = folderCheckState(node.children);
        const checked = state === "checked";
        const indeterminate = state === "partial";
        const collapsed = collapsedFolders.has(node.path) && !needle;

        if (inline) {
          return (
            <li key={`folder:${node.path}`}>
              <div
                className="flex items-center gap-1 py-0.5 text-sm"
                style={{ paddingLeft: `${depth * 0.9}rem` }}
              >
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                  aria-label={collapsed ? "Expand folder" : "Collapse folder"}
                  onClick={() => onToggleFolderExpand(node.path)}
                >
                  {collapsed ? (
                    <span className="inline-block w-3 text-center text-xs">▸</span>
                  ) : (
                    <span className="inline-block w-3 text-center text-xs">▾</span>
                  )}
                </button>
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    ref={(el) => {
                      if (el) el.indeterminate = indeterminate;
                    }}
                    disabled={disabled}
                    onChange={(e) => onToggleFolder(node.path, e.target.checked)}
                  />
                  <button
                    type="button"
                    className="truncate text-left font-medium"
                    onClick={() => onToggleFolderExpand(node.path)}
                  >
                    {node.path || "(root)"}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">folder</span>
                  </button>
                </label>
              </div>
              {!collapsed && (
                <ul className="list-none p-0">
                  <TreeRows
                    nodes={node.children}
                    depth={depth + 1}
                    filter={filter}
                    sortBy={sortBy}
                    onToggleFolder={onToggleFolder}
                    onToggleFile={onToggleFile}
                    onFileSelect={onFileSelect}
                    selectedFilePath={selectedFilePath}
                    disabled={disabled}
                    variant={variant}
                    collapsedFolders={collapsedFolders}
                    onToggleFolderExpand={onToggleFolderExpand}
                    projectId={projectId}
                    enableFileCategoryDrag={enableFileCategoryDrag}
                  />
                </ul>
              )}
            </li>
          );
        }

        return (
          <li key={`folder:${node.path}`} className="tree-folder-block">
            <div className="tree-folder" style={{ paddingLeft: `${depth * 1.1}rem` }}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  ref={(el) => {
                    if (el) el.indeterminate = indeterminate;
                  }}
                  disabled={disabled}
                  onChange={(e) => onToggleFolder(node.path, e.target.checked)}
                />
                <span>{node.path || "(root)"}</span>
                <span className="muted small"> folder</span>
              </label>
            </div>
            <ul className="path-tree nested">
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                filter={filter}
                sortBy={sortBy}
                onToggleFolder={onToggleFolder}
                onToggleFile={onToggleFile}
                onFileSelect={onFileSelect}
                selectedFilePath={selectedFilePath}
                disabled={disabled}
                variant={variant}
                collapsedFolders={collapsedFolders}
                onToggleFolderExpand={onToggleFolderExpand}
                projectId={projectId}
                enableFileCategoryDrag={enableFileCategoryDrag}
              />
            </ul>
          </li>
        );
      })}
    </>
  );
}

export default function ImportRulesTree({
  projectId,
  onRulesChange,
  disabled,
  variant = "default",
  selectedFilePath = null,
  onFileSelect,
  onSelectionStats,
  className,
  enableFileCategoryDrag = false,
}: Props) {
  const [nodes, setNodes] = useState<StlTreeNode[]>([]);
  const [total, setTotal] = useState(0);
  const [legacyAll, setLegacyAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState<ImportRulesSort>("path");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const onRulesChangeRef = useRef(onRulesChange);
  onRulesChangeRef.current = onRulesChange;
  const inline = variant === "inline";

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchStlTree(projectId);
      setNodes(data.nodes);
      setTotal(data.total);
      setLegacyAll(data.legacy_import_all);
      onRulesChangeRef.current(compressRulesFromClientTree(data.nodes), {
        userInitiated: false,
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!inline) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline]);

  const selected = useMemo(() => collectCheckedFiles(nodes).length, [nodes]);
  const duplicateBasenames = useMemo(
    () => findDuplicateBasenames(collectCheckedFiles(nodes)),
    [nodes],
  );
  const visibleFilePaths = useMemo(
    () => collectVisibleFilePaths(nodes, filter),
    [nodes, filter],
  );

  useEffect(() => {
    onSelectionStats?.(selected, total, duplicateBasenames);
  }, [selected, total, duplicateBasenames, onSelectionStats]);

  const applyNodes = (next: StlTreeNode[], userInitiated = true) => {
    const synced = refreshFolderStates(next);
    setNodes(synced);
    onRulesChange(compressRulesFromClientTree(synced), { userInitiated });
  };

  const suggestFromFolders = () => {
    const suggested = suggestRulesFromTopLevelFolders(nodes);
    if (suggested.length === 0) return;
    const synced = refreshFolderStates(setAllChecked(nodes, false));
    let next = synced;
    for (const rule of suggested) {
      const folderPath = rule.replace(/\/$/, "");
      next = setFolderChecked(next, folderPath, true);
    }
    applyNodes(next);
  };

  const selectAllVisible = () => {
    if (visibleFilePaths.length === 0) return;
    applyNodes(setFilesChecked(nodes, new Set(visibleFilePaths), true));
  };

  const selectVisibleFolder = () => {
    if (!selectedFilePath) return;
    const folderPath = selectedFilePath.includes("/")
      ? selectedFilePath.slice(0, selectedFilePath.lastIndexOf("/"))
      : "";
    applyNodes(setFolderChecked(nodes, folderPath, true));
  };

  const onTreeKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!inline || !onFileSelect || visibleFilePaths.length === 0) return;
    const currentIndex = selectedFilePath ? visibleFilePaths.indexOf(selectedFilePath) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = visibleFilePaths[Math.min(currentIndex + 1, visibleFilePaths.length - 1)];
      if (next) onFileSelect(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = visibleFilePaths[Math.max(currentIndex - 1, 0)];
      if (next) onFileSelect(next);
    } else if (e.key === " " && selectedFilePath) {
      e.preventDefault();
      const fileNode = findFileNode(nodes, selectedFilePath);
      if (fileNode?.kind === "file") {
        applyNodes(setFileChecked(nodes, selectedFilePath, !fileNode.checked));
      }
    }
  };

  const toggleFolderExpand = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (loading) {
    return (
      <p className={cn(inline ? "text-sm text-muted-foreground" : "muted", className)}>
        Loading STL tree…
      </p>
    );
  }
  if (loadError) {
    return (
      <p className={cn(inline ? "text-sm text-destructive" : "status-err", className)}>
        {loadError}
      </p>
    );
  }

  const toolbar = inline ? (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        ref={searchRef}
        type="search"
        placeholder="Filter paths… (press /)"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="min-w-[140px] flex-1"
        aria-label="Filter STL paths"
      />
      <select
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={sortBy}
        onChange={(e) => setSortBy(e.target.value as ImportRulesSort)}
        aria-label="Sort files"
      >
        <option value="path">Sort: path</option>
        <option value="name">Sort: name</option>
      </select>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={selectAllVisible}
        disabled={disabled || visibleFilePaths.length === 0}
      >
        Select visible
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => applyNodes(setAllChecked(nodes, false))}
        disabled={disabled}
      >
        Clear all
      </Button>
      {selectedFilePath && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={selectVisibleFolder}
          disabled={disabled}
          title="Check all files in the folder of the selected file"
        >
          Select folder
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={() => void reload()} disabled={disabled}>
        Reload
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={suggestFromFolders}
        disabled={disabled || nodes.length === 0}
        title="Check top-level folders (excludes Library, Manual, .github, images, …)"
      >
        Suggest folders
      </Button>
    </div>
  ) : (
    <div className="toolbar-row">
      <input
        type="search"
        placeholder="Filter paths…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="tree-filter"
      />
      <button type="button" onClick={() => applyNodes(setAllChecked(nodes, false))} disabled={disabled}>
        Clear all
      </button>
      <button type="button" onClick={() => void reload()} disabled={disabled}>
        Reload
      </button>
      <button
        type="button"
        onClick={suggestFromFolders}
        disabled={disabled || nodes.length === 0}
        title="Check top-level folders (excludes Library, Manual, .github, images, …)"
      >
        Suggest from top-level folders
      </button>
    </div>
  );

  return (
    <div className={cn(inline ? "space-y-2" : "import-tree", className)}>
      {!inline && (
        <p className="muted">
          Check STL files or folders to include. Unchecked paths stay out of the saved Plan draft when you Rebuild.
          {legacyAll && " (Legacy import-all — adjust selection to opt in.)"}
        </p>
      )}
      {inline && legacyAll && (
        <p className="text-xs text-muted-foreground">
          Legacy import-all — adjust selection to opt in.
        </p>
      )}
      {toolbar}
      {!inline && (
        <p className="result">
          {selected} of {total} STL file(s) selected
        </p>
      )}
      {inline && (
        <p className="text-xs text-muted-foreground">
          {selected} of {total} STL file(s) selected
          {filter.trim() ? ` · ${visibleFilePaths.length} visible` : ""}
        </p>
      )}
      <ul
        ref={treeRef}
        className={cn(
          inline
            ? "max-h-[360px] list-none overflow-auto rounded-md border border-border p-2"
            : "path-tree",
        )}
        tabIndex={inline ? 0 : undefined}
        onKeyDown={inline ? onTreeKeyDown : undefined}
        role={inline ? "tree" : undefined}
        aria-label={inline ? "STL import file tree" : undefined}
      >
        <TreeRows
          nodes={nodes}
          depth={0}
          filter={filter}
          sortBy={sortBy}
          onToggleFolder={(path, checked) => applyNodes(setFolderChecked(nodes, path, checked))}
          onToggleFile={(path, checked) => applyNodes(setFileChecked(nodes, path, checked))}
          onFileSelect={onFileSelect}
          selectedFilePath={selectedFilePath}
          disabled={disabled}
          variant={variant}
          collapsedFolders={collapsedFolders}
          onToggleFolderExpand={toggleFolderExpand}
          projectId={projectId}
          enableFileCategoryDrag={enableFileCategoryDrag}
        />
      </ul>
      {total === 0 && (
        <p className={cn(inline ? "text-sm text-muted-foreground" : "muted")}>
          No STL files found — sync the repo first.
        </p>
      )}
    </div>
  );
}

function findFileNode(nodes: StlTreeNode[], path: string): StlTreeNode | null {
  for (const node of nodes) {
    if (node.kind === "file" && node.path === path) return node;
    if (node.kind === "folder") {
      const found = findFileNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

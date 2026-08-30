import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronRight, FileCode2, Folder, FolderOpen, RefreshCw, Search, Upload } from "lucide-react";
import type {
  PrinterStorageEntry,
  PrinterStoredFile,
  ProfileSummary,
} from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../../api/endpoints/checkoff";
import {
  fetchPrinterStorageListing,
  openPrinterStoredFile,
  type PrinterMachine,
} from "../../api/endpoints/printers";
import type { IntegrationSummary } from "../../api/endpoints/integrations";
import { parseSlicedObjectsFile } from "../../lib/parseSlicedObjects";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import InlineOperationError from "./InlineOperationError";
import PrintFileAssignForm, { type ChosenPrintFile } from "./PrintFileAssignForm";
import { failureMessage, useAsyncView } from "./asyncView";
import { sortStorageEntries, storageCrumbs } from "./printFileAssignment";

type Props = {
  printer: PrinterMachine;
  host: IntegrationSummary | null;
  /** Whether the linked host can list stored files. Comes from the server. */
  canBrowse: boolean;
  profiles: ProfileSummary[];
  selectedProfileId: number | null;
  onAssigned: (link: PrinterCheckoffLink) => void;
};

type FileSource = "printer" | "computer";

/** Reading a file's bytes and object labels, before any Build is involved. */
type InspectState =
  | { phase: "idle" }
  | { phase: "running"; label: string }
  | { phase: "failed"; title: string; message: string; retry: () => void };

const PRINT_FILE_PATTERN = /\.(?:gcode|gco|bgcode|3mf)$/i;

/**
 * Find or provide a print file for one printer, then assign it.
 *
 * Split out of the workspace sheet because it changes for print-file reasons: a
 * new container format, a new storage layout. Camera work and Checkoff work do
 * not touch any of it.
 */
export default function PrinterFilesView({
  printer,
  host,
  canBrowse,
  profiles,
  selectedProfileId,
  onAssigned,
}: Props) {
  const [source, setSource] = useState<FileSource>(canBrowse ? "printer" : "computer");
  const [chosen, setChosen] = useState<ChosenPrintFile | null>(null);
  const [inspect, setInspect] = useState<InspectState>({ phase: "idle" });

  const inspectFile = async (file: File, remotePath?: string) => {
    setInspect({ phase: "running", label: file.name });
    try {
      const parsed = await parseSlicedObjectsFile(file);
      setChosen({ file, remotePath, objectNames: parsed.names });
      setInspect({ phase: "idle" });
    } catch (error) {
      setInspect({
        phase: "failed",
        title: `Could not read ${file.name}`,
        message: failureMessage(error, "The file could not be read."),
        retry: () => void inspectFile(file, remotePath),
      });
    }
  };

  const openStoredFile = async (storedFile: PrinterStoredFile) => {
    setInspect({ phase: "running", label: storedFile.name });
    try {
      const file = await openPrinterStoredFile({ printerId: printer.id, file: storedFile });
      const parsed = await parseSlicedObjectsFile(file);
      setChosen({ file, remotePath: storedFile.path, objectNames: parsed.names });
      setInspect({ phase: "idle" });
    } catch (error) {
      setInspect({
        phase: "failed",
        title: `Could not open ${storedFile.name}`,
        message: failureMessage(error, "The printer host did not return the file."),
        retry: () => void openStoredFile(storedFile),
      });
    }
  };

  const busy = inspect.phase === "running";

  return (
    <div className="stack-section">
      {canBrowse ? (
        <div className="stack-row rounded-lg border border-border bg-surface-sunken p-3">
          <p className="text-body font-medium">Where is the file?</p>
          <SegmentedControl
            aria-label="Where is the file?"
            value={source}
            onValueChange={setSource}
            options={[
              {
                value: "printer",
                label: `On ${printer.name}`,
                icon: <FolderOpen className="h-4 w-4" aria-hidden />,
              },
              {
                value: "computer",
                label: "On this computer",
                icon: <Upload className="h-4 w-4" aria-hidden />,
              },
            ]}
          />
        </div>
      ) : null}

      {source === "printer" && canBrowse ? (
        <StorageBrowser
          printer={printer}
          busy={busy}
          onOpenFile={(file) => void openStoredFile(file)}
        />
      ) : (
        <LocalFilePicker busy={busy} onPick={(file) => void inspectFile(file)} />
      )}

      {inspect.phase === "running" ? (
        <p className="text-body text-muted-foreground" role="status">
          Reading {inspect.label}…
        </p>
      ) : null}

      {inspect.phase === "failed" ? (
        <InlineOperationError
          title={inspect.title}
          message={inspect.message}
          onRetry={inspect.retry}
          retryLabel="Try again"
        />
      ) : null}

      {chosen ? (
        <PrintFileAssignForm
          key={chosen.remotePath ?? chosen.file.name}
          printer={printer}
          host={host}
          profiles={profiles}
          selectedProfileId={selectedProfileId}
          chosen={chosen}
          onCancel={() => setChosen(null)}
          onAssigned={(link) => {
            setChosen(null);
            onAssigned(link);
          }}
        />
      ) : null}
    </div>
  );
}

/** One directory of the printer host's storage, with the trail back to the root. */
function StorageBrowser({
  printer,
  busy,
  onOpenFile,
}: {
  printer: PrinterMachine;
  busy: boolean;
  onOpenFile: (file: PrinterStoredFile) => void;
}) {
  const [path, setPath] = useState("");
  const request = useCallback(
    () => fetchPrinterStorageListing({ printerId: printer.id, path }),
    [printer.id, path],
  );
  const { view, reload } = useAsyncView({
    request,
    fallbackMessage: "The printer host did not answer the request.",
  });

  const crumbs = storageCrumbs(path);

  return (
    <section aria-label={`Files on ${printer.name}`} className="stack-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="section-heading text-body">Files on {printer.name}</h3>
          <p className="text-meta text-muted-foreground">
            Open a file to read its object labels. Nothing starts printing.
          </p>
        </div>
        <Button
          size="shop"
          variant="outline"
          onClick={reload}
          disabled={view.status === "loading"}
        >
          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
          Refresh
        </Button>
      </div>

      <nav aria-label="Printer folder trail" className="flex flex-wrap items-center gap-0.5">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center gap-0.5">
            {index > 0 ? (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            ) : null}
            {crumb.path === path ? (
              <span aria-current="location" className="px-1.5 text-meta font-medium">
                {crumb.label}
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 px-2"
                onClick={() => setPath(crumb.path)}
              >
                {crumb.label}
              </Button>
            )}
          </span>
        ))}
      </nav>

      {view.status === "loading" ? (
        <p className="text-body text-muted-foreground" role="status">
          Loading {crumbs[crumbs.length - 1].label}…
        </p>
      ) : view.status === "failed" ? (
        <InlineOperationError
          title={`Could not list files on ${printer.name}`}
          message={view.message}
          onRetry={reload}
          retryLabel="Try again"
        />
      ) : (
        <StorageEntries
          entries={sortStorageEntries(view.data.entries)}
          busy={busy}
          onEnter={setPath}
          onOpenFile={onOpenFile}
        />
      )}
    </section>
  );
}

function StorageEntries({
  entries,
  busy,
  onEnter,
  onOpenFile,
}: {
  entries: readonly PrinterStorageEntry[];
  busy: boolean;
  onEnter: (path: string) => void;
  onOpenFile: (file: PrinterStoredFile) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "name" | "largest">("newest");
  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = normalized
      ? entries.filter((entry) =>
          `${entry.name} ${entry.path}`.toLocaleLowerCase().includes(normalized),
        )
      : [...entries];
    return filtered.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      if (left.kind === "directory" || right.kind === "directory" || sort === "name") {
        return left.name.localeCompare(right.name, undefined, { numeric: true });
      }
      if (sort === "largest") {
        return (
          (right.size_bytes ?? -1) - (left.size_bytes ?? -1) ||
          left.name.localeCompare(right.name)
        );
      }
      const rightTime = modifiedTime(right.modified_at);
      const leftTime = modifiedTime(left.modified_at);
      return rightTime - leftTime || left.name.localeCompare(right.name);
    });
  }, [entries, query, sort]);
  const folderCount = visibleEntries.filter((entry) => entry.kind === "directory").length;
  const fileCount = visibleEntries.length - folderCount;

  if (entries.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border-strong p-4 text-body text-muted-foreground">
        This folder is empty.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search this folder</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this folder…"
            className="pl-9"
          />
        </label>
        <label className="flex items-center gap-2 text-meta text-muted-foreground">
          <span>Sort</span>
          <select
            className="min-h-10 rounded-md border border-input bg-background px-3 text-body text-foreground"
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="newest">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="largest">Largest first</option>
          </select>
        </label>
      </div>
      <p className="text-meta text-muted-foreground">
        {fileCount} {fileCount === 1 ? "file" : "files"} · {folderCount}{" "}
        {folderCount === 1 ? "folder" : "folders"}
      </p>
      {visibleEntries.length === 0 ? (
        <p className="rounded-md border border-dashed border-border-strong p-4 text-body text-muted-foreground">
          No files or folders match “{query}”.
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {visibleEntries.map((entry) =>
            entry.kind === "directory" ? (
              <li key={entry.path}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/60"
                  onClick={() => onEnter(entry.path)}
                >
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-body font-medium">
                    {entry.name}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ) : (
              <li key={entry.path} className="flex min-h-11 items-center gap-3 p-3">
                <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-body font-medium" title={entry.path}>
                    {entry.name}
                  </p>
                  <p className="truncate text-meta text-muted-foreground">
                    {[
                      printFileType(entry.name),
                      formatBytes(entry.size_bytes),
                      formatModified(entry.modified_at),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {PRINT_FILE_PATTERN.test(entry.name) ? (
                  <Button
                    size="shop"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onOpenFile(entry)}
                  >
                    Open
                  </Button>
                ) : (
                  <span className="shrink-0 text-meta text-muted-foreground">
                    Not a print file
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function LocalFilePicker({ busy, onPick }: { busy: boolean; onPick: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  return (
    <section className="stack-row" aria-label="Provide a print file">
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept=".gcode,.gco,.bgcode,.3mf,application/octet-stream"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (PRINT_FILE_PATTERN.test(file.name)) {
            setRejected(null);
            onPick(file);
          } else {
            setRejected(file.name);
          }
        }}
      />
      <Button
        size="shop"
        variant="outline"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="mr-1.5 h-4 w-4" aria-hidden />
        {busy ? "Reading…" : "Choose a print file"}
      </Button>
      {rejected ? (
        <InlineOperationError
          title={`${rejected} is not a print file`}
          message="Choose a .gcode, .gco, .bgcode, or .3mf file."
          onRetry={() => inputRef.current?.click()}
          retryLabel="Choose another file"
        />
      ) : null}
      <p className="text-meta text-muted-foreground">
        Use this for SD-card, USB, cloud, or any other printer PrintPartner cannot watch. A .3mf is
        checked before it can be assigned, so a project file cannot be mistaken for a print.
      </p>
    </section>
  );
}

/** Missing provider metadata reads as unknown, never as zero or a guess. */
function formatBytes(bytes?: number): string | null {
  if (bytes == null) return null;
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatModified(value?: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString();
}

function modifiedTime(value?: string): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function printFileType(name: string): string {
  const extension = name.split(".").pop()?.trim().toUpperCase();
  return extension ? `${extension} file` : "File";
}

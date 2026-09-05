import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Download, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import ConfirmDialog from "../ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { statusTone } from "../../lib/statusTone";
import { cn } from "../../lib/utils";

type Backup = Readonly<{
  name: string;
  createdAt: string;
  size: number;
}>;

type BackupMetadataBase = Readonly<{
  version: string;
  createdAt: string;
  appVersion: string;
}>;

type BackupMetadata =
  | (BackupMetadataBase & Readonly<{ version: "1"; formatVersion: 1 }>)
  | (BackupMetadataBase &
      Readonly<{
        version: "2";
        formatVersion: 2;
        scope:
          | Readonly<{ kind: "full"; includedRoots: readonly string[] }>
          | Readonly<{ kind: "database-only"; includedRoots: readonly [] }>;
      }>);

type RestorePreflight = Readonly<{
  archiveBytes: number;
  requiredBytes: number;
  freeBytes: number;
  sufficient: boolean;
}>;

type StorageCategory = Readonly<{
  key: string;
  label: string;
  bytes: number;
  files: number;
}>;

type StorageInventory = Readonly<{
  categories: readonly StorageCategory[];
  totalBytes: number;
  backupContentBytes: number;
  freeBytes: number;
}>;

type RestoreTarget =
  | Readonly<{
      kind: "stored";
      backup: Backup;
      metadata: BackupMetadata;
      preflight: RestorePreflight;
    }>
  | Readonly<{
      kind: "upload";
      file: File;
      metadata: BackupMetadata;
      preflight: RestorePreflight;
    }>;

type RestoreFlow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "validating" }>
  | Readonly<{ phase: "checking"; backup: Backup }>
  | Readonly<{ phase: "confirming"; target: RestoreTarget }>
  | Readonly<{ phase: "restoring"; target: RestoreTarget }>;

function isBackup(value: unknown): value is Backup {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    "size" in value &&
    isNonNegativeNumber(value.size)
  );
}

function parseBackupList(value: unknown): Backup[] {
  if (!Array.isArray(value) || !value.every(isBackup)) {
    throw new Error("The server returned an invalid backup list");
  }
  return value;
}

function isBackupMetadata(value: unknown): value is BackupMetadata {
  if (
    !(
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      typeof value.version === "string" &&
      "createdAt" in value &&
      typeof value.createdAt === "string" &&
      !Number.isNaN(Date.parse(value.createdAt)) &&
      "appVersion" in value &&
      typeof value.appVersion === "string" &&
      "formatVersion" in value &&
      isNonNegativeNumber(value.formatVersion)
    )
  ) {
    return false;
  }
  if (value.version === "1" && value.formatVersion === 1) return true;
  return (
    value.version === "2" &&
    value.formatVersion === 2 &&
    "scope" in value &&
    typeof value.scope === "object" &&
    value.scope !== null &&
    "kind" in value.scope &&
    (value.scope.kind === "full" || value.scope.kind === "database-only") &&
    "includedRoots" in value.scope &&
    Array.isArray(value.scope.includedRoots) &&
    value.scope.includedRoots.every((root) => typeof root === "string") &&
    (value.scope.kind === "full" || value.scope.includedRoots.length === 0)
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRestorePreflight(value: unknown): RestorePreflight {
  if (
    typeof value !== "object" ||
    value === null ||
    !("archiveBytes" in value) ||
    !isNonNegativeNumber(value.archiveBytes) ||
    !("requiredBytes" in value) ||
    !isNonNegativeNumber(value.requiredBytes) ||
    !("freeBytes" in value) ||
    !isNonNegativeNumber(value.freeBytes) ||
    !("sufficient" in value) ||
    typeof value.sufficient !== "boolean" ||
    value.archiveBytes > value.requiredBytes ||
    value.sufficient !== (value.freeBytes >= value.requiredBytes)
  ) {
    throw new Error("The server returned an invalid restore preflight");
  }
  return {
    archiveBytes: value.archiveBytes,
    requiredBytes: value.requiredBytes,
    freeBytes: value.freeBytes,
    sufficient: value.sufficient,
  };
}

function isStorageCategory(value: unknown): value is StorageCategory {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    typeof value.key === "string" &&
    "label" in value &&
    typeof value.label === "string" &&
    "bytes" in value &&
    isNonNegativeNumber(value.bytes) &&
    "files" in value &&
    isNonNegativeNumber(value.files)
  );
}

function parseValidation(value: unknown): Readonly<{
  metadata: BackupMetadata;
  preflight: RestorePreflight;
}> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("valid" in value) ||
    value.valid !== true ||
    !("metadata" in value) ||
    !isBackupMetadata(value.metadata) ||
    !("restorePreflight" in value)
  ) {
    throw new Error("The server could not verify this backup");
  }
  return {
    metadata: value.metadata,
    preflight: parseRestorePreflight(value.restorePreflight),
  };
}

function parseInspection(value: unknown): Readonly<{
  metadata: BackupMetadata;
  preflight: RestorePreflight;
}> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("metadata" in value) ||
    !isBackupMetadata(value.metadata) ||
    !("restorePreflight" in value)
  ) {
    throw new Error("The server returned an invalid backup inspection");
  }
  return {
    metadata: value.metadata,
    preflight: parseRestorePreflight(value.restorePreflight),
  };
}

function restoreScopeDescription(metadata: BackupMetadata): string {
  if (metadata.formatVersion === 1) {
    return "This legacy backup replaces the database and archived data paths. Paths absent from the archive stay unchanged.";
  }
  if (metadata.scope.kind === "database-only") {
    return "This database-only backup leaves stored files unchanged and replaces only the database.";
  }
  return "This full backup replaces the database and every scoped data path. A scoped path that was absent when the backup was created is removed.";
}

function parseStorageInventory(value: unknown): StorageInventory {
  if (
    typeof value !== "object" ||
    value === null ||
    !("categories" in value) ||
    !Array.isArray(value.categories) ||
    !value.categories.every(isStorageCategory) ||
    !("totalBytes" in value) ||
    !isNonNegativeNumber(value.totalBytes) ||
    !("backupContentBytes" in value) ||
    !isNonNegativeNumber(value.backupContentBytes) ||
    !("freeBytes" in value) ||
    !isNonNegativeNumber(value.freeBytes)
  ) {
    throw new Error("The server returned an invalid storage inventory");
  }
  const measuredTotal = value.categories.reduce(
    (total, category) => total + category.bytes,
    0,
  );
  if (!Number.isSafeInteger(measuredTotal) || measuredTotal !== value.totalBytes) {
    throw new Error("The server returned an inconsistent storage inventory");
  }
  return {
    categories: value.categories,
    totalBytes: value.totalBytes,
    backupContentBytes: value.backupContentBytes,
    freeBytes: value.freeBytes,
  };
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = parseFloat((bytes / 1024 ** unitIndex).toFixed(2));
  return `${value} ${units[unitIndex]}`;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const value: unknown = await response.json();
    if (
      typeof value === "object" &&
      value !== null &&
      "detail" in value &&
      typeof value.detail === "string"
    ) {
      return new Error(value.detail);
    }
  } catch {
    // The fallback still tells the operator which action failed.
  }
  return new Error(fallback);
}

export default function BackupManagementCard() {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const restoreDescriptionId = useId();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [storage, setStorage] = useState<StorageInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreFlow, setRestoreFlow] = useState<RestoreFlow>({ phase: "idle" });

  const loadBackups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [backupsResponse, storageResponse] = await Promise.all([
        fetch("/backups"),
        fetch("/backups/storage"),
      ]);
      if (!backupsResponse.ok) throw new Error("Failed to load backups");
      const backupData: unknown = await backupsResponse.json();
      setBackups(parseBackupList(backupData));
      if (!storageResponse.ok) throw new Error("Failed to inspect server storage");
      const storageData: unknown = await storageResponse.json();
      setStorage(parseStorageInventory(storageData));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBackups();
    // Refresh when the tab regains focus
    const onFocus = () => {
      if (document.visibilityState === "visible") void loadBackups();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [loadBackups]);

  const handleCreateBackup = async () => {
    setCreating(true);
    try {
      const response = await fetch("/backups", { method: "POST" });
      if (!response.ok) throw new Error("Backup creation failed");
      await loadBackups();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create backup");
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = (id: string) => {
    const link = document.createElement("a");
    link.href = `/backups/${encodeURIComponent(id)}`;
    link.download = id;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleUploadFile = async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".tar.gz")) {
      setError("Choose a PrintPartner backup ending in .tar.gz");
      setRestoreFlow({ phase: "idle" });
      return;
    }

    setRestoreFlow({ phase: "validating" });
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const response = await fetch("/backups/validate", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw await responseError(response, "Backup validation failed");
      const value: unknown = await response.json();
      const { metadata, preflight } = parseValidation(value);
      setRestoreFlow({
        phase: "confirming",
        target: { kind: "upload", file, metadata, preflight },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup validation failed");
      setRestoreFlow({ phase: "idle" });
    }
  };

  const handleStoredRestore = async (backup: Backup) => {
    setError(null);
    setRestoreFlow({ phase: "checking", backup });
    try {
      const response = await fetch(
        `/backups/${encodeURIComponent(backup.name)}/preflight`,
      );
      if (!response.ok) throw await responseError(response, "Backup preflight failed");
      const value: unknown = await response.json();
      const { metadata, preflight } = parseInspection(value);
      setRestoreFlow({
        phase: "confirming",
        target: { kind: "stored", backup, metadata, preflight },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup preflight failed");
      setRestoreFlow({ phase: "idle" });
    }
  };

  const handleRestore = async () => {
    if (restoreFlow.phase !== "confirming") return;
    const target = restoreFlow.target;
    setRestoreFlow({ phase: "restoring", target });
    try {
      let response: Response;
      if (target.kind === "upload") {
        const form = new FormData();
        form.append("file", target.file, target.file.name);
        response = await fetch("/backups/restore", { method: "POST", body: form });
      } else {
        response = await fetch("/backups/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backupName: target.backup.name }),
        });
      }
      if (!response.ok) throw await responseError(response, "Restore failed");
      setRestoreFlow({ phase: "idle" });
      setError(null);
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
      setRestoreFlow({ phase: "confirming", target });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`/backups/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Delete failed");
      await loadBackups();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const formatDate = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const restoreTarget =
    restoreFlow.phase === "confirming" || restoreFlow.phase === "restoring"
      ? restoreFlow.target
      : null;
  const restoring = restoreFlow.phase === "restoring";
  const validating = restoreFlow.phase === "validating";
  const checking = restoreFlow.phase === "checking";

  return (
    <Card>
      <CardHeader>
        <CardTitle level={3}>Backup & Restore</CardTitle>
        <CardDescription>
          Create backups on this server, download them, or restore a PrintPartner backup from
          your computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div
            className={cn("flex gap-2 rounded-lg p-3 text-sm", statusTone({
              tone: "error",
              emphasis: "soft",
            }))}
          >
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <input
          ref={uploadInputRef}
          type="file"
          className="sr-only"
          aria-label="Backup file to restore"
          accept=".tar.gz,application/gzip,application/x-gzip"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleUploadFile(file);
          }}
        />

        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Button
            onClick={handleCreateBackup}
            disabled={loading || creating || validating || checking || restoring}
          >
            {creating ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                Creating...
              </>
            ) : (
              "Create backup"
            )}
          </Button>
          <Button
            onClick={() => uploadInputRef.current?.click()}
            variant="outline"
            disabled={loading || creating || validating || checking || restoring}
          >
            {validating ? (
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-4 w-4" aria-hidden />
            )}
            {validating ? "Checking backup..." : "Restore backup file"}
          </Button>
          <Button
            onClick={loadBackups}
            variant="outline"
            disabled={loading || creating || validating || checking || restoring}
            aria-label="Refresh backup list"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Downloaded backups use the <code className="font-mono">.tar.gz</code> format. PrintPartner
          checks an uploaded file before it shows the restore confirmation.
        </p>

        {storage && (
          <section aria-label="Server storage" className="space-y-3 rounded-lg border p-3">
            <div className="grid gap-1 text-sm sm:grid-cols-2">
              <p>
                <span className="font-medium">Estimated backup contents:</span>{" "}
                {formatSize(storage.backupContentBytes)}
              </p>
              <p>
                <span className="font-medium">Application data:</span>{" "}
                {formatSize(storage.totalBytes)}
              </p>
              <p>
                <span className="font-medium">Server free space:</span>{" "}
                {formatSize(storage.freeBytes)}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
              {storage.categories.map((category) => (
                <div key={category.key}>
                  <dt>{category.label}</dt>
                  <dd className="font-medium text-foreground">
                    {formatSize(category.bytes)} · {category.files}{" "}
                    {category.files === 1 ? "file" : "files"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {backups.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              {backups.length} backup{backups.length !== 1 ? "s" : ""}
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {backups.map((backup) => (
                <div
                  key={backup.name}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{backup.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(backup.createdAt)} • {formatSize(backup.size)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleDownload(backup.name)}
                      size="sm"
                      variant="outline"
                      aria-label={`Download backup ${backup.name}`}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      onClick={() => void handleStoredRestore(backup)}
                      size="sm"
                      variant="outline"
                      disabled={checking || validating || restoring}
                    >
                      {restoreFlow.phase === "checking" &&
                      restoreFlow.backup.name === backup.name
                        ? "Checking..."
                        : "Restore"}
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          aria-label={`Delete backup ${backup.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      }
                      title="Delete this backup?"
                      description={
                        <>
                          “{backup.name}” is removed from this server. This cannot be
                          undone.
                        </>
                      }
                      confirmLabel="Delete backup"
                      onConfirm={() => void handleDelete(backup.name)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No backups yet</p>
        )}

        <Dialog
          open={restoreTarget !== null}
          onOpenChange={(open) => {
            if (!open && !restoring) setRestoreFlow({ phase: "idle" });
          }}
        >
          <DialogContent aria-describedby={restoreDescriptionId}>
            <DialogHeader>
              <DialogTitle>
                {restoreTarget?.kind === "upload" ? "Restore uploaded backup" : "Restore backup"}
              </DialogTitle>
            </DialogHeader>
            {restoreTarget && (
              <div className="space-y-4">
                <div className="rounded-lg border border-border-strong bg-muted/30 p-3">
                  <p className="break-all font-mono text-sm font-medium">
                    {restoreTarget.kind === "upload"
                      ? restoreTarget.file.name
                      : restoreTarget.backup.name}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {restoreTarget.kind === "upload"
                      ? `Created ${formatDate(restoreTarget.metadata.createdAt)} with PrintPartner ${restoreTarget.metadata.appVersion}`
                      : `${formatDate(restoreTarget.backup.createdAt)} · ${formatSize(restoreTarget.backup.size)}`}
                  </p>
                </div>
                <p id={restoreDescriptionId} className="text-sm text-muted-foreground">
                  {restoreScopeDescription(restoreTarget.metadata)} PrintPartner stages the
                  replacement, keeps the current data available for rollback, then reloads the
                  app.
                </p>
                <div
                  className={cn("rounded-lg p-3 text-sm", statusTone({
                    tone: restoreTarget.preflight.sufficient ? "info" : "error",
                    emphasis: "soft",
                  }))}
                  role={restoreTarget.preflight.sufficient ? "status" : "alert"}
                >
                  {restoreTarget.preflight.sufficient ? (
                    <p>
                      Restore needs {formatSize(restoreTarget.preflight.requiredBytes)} of free
                      space. This server currently reports{" "}
                      {formatSize(restoreTarget.preflight.freeBytes)} free.
                    </p>
                  ) : (
                    <p>
                      This server does not have enough free space. Restore needs{" "}
                      {formatSize(restoreTarget.preflight.requiredBytes)}, but only{" "}
                      {formatSize(restoreTarget.preflight.freeBytes)} is free.
                    </p>
                  )}
                </div>
                <div className="flex gap-2 pt-4">
                  <Button
                    onClick={handleRestore}
                    disabled={restoring || !restoreTarget.preflight.sufficient}
                    className="flex-1"
                  >
                    {restoring ? "Restoring..." : "Restore this backup"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={restoring}
                    onClick={() => setRestoreFlow({ phase: "idle" })}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

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

type Backup = Readonly<{
  name: string;
  createdAt: string;
  size: number;
}>;

type BackupMetadata = Readonly<{
  version: string;
  createdAt: string;
  appVersion: string;
  formatVersion: number;
}>;

type RestoreTarget =
  | Readonly<{ kind: "stored"; backup: Backup }>
  | Readonly<{ kind: "upload"; file: File; metadata: BackupMetadata }>;

type RestoreFlow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "validating" }>
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
    "size" in value &&
    typeof value.size === "number"
  );
}

function parseBackupList(value: unknown): Backup[] {
  if (!Array.isArray(value) || !value.every(isBackup)) {
    throw new Error("The server returned an invalid backup list");
  }
  return value;
}

function isBackupMetadata(value: unknown): value is BackupMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "appVersion" in value &&
    typeof value.appVersion === "string" &&
    "formatVersion" in value &&
    typeof value.formatVersion === "number"
  );
}

function parseValidationMetadata(value: unknown): BackupMetadata {
  if (
    typeof value !== "object" ||
    value === null ||
    !("valid" in value) ||
    value.valid !== true ||
    !("metadata" in value) ||
    !isBackupMetadata(value.metadata)
  ) {
    throw new Error("The server could not verify this backup");
  }
  return value.metadata;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreFlow, setRestoreFlow] = useState<RestoreFlow>({ phase: "idle" });

  const loadBackups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/backups");
      if (!response.ok) throw new Error("Failed to load backups");
      const data: unknown = await response.json();
      setBackups(parseBackupList(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBackups();
    // Refresh when the tab regains focus
    const onFocus = () => void loadBackups();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [loadBackups]);

  const handleCreateBackup = async () => {
    setLoading(true);
    try {
      const response = await fetch("/backups", { method: "POST" });
      if (!response.ok) throw new Error("Backup creation failed");
      await loadBackups();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create backup");
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (id: string) => {
    try {
      const response = await fetch(`/backups/${id}`);
      if (!response.ok) throw new Error("Download failed");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = id;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
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
      const metadata = parseValidationMetadata(value);
      setRestoreFlow({ phase: "confirming", target: { kind: "upload", file, metadata } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup validation failed");
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
      const response = await fetch(`/backups/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      await loadBackups();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
          <div className="flex gap-2 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
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
            disabled={loading || validating || restoring}
          >
            {loading ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create backup"
            )}
          </Button>
          <Button
            onClick={() => uploadInputRef.current?.click()}
            variant="outline"
            disabled={loading || validating || restoring}
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
            disabled={loading || validating || restoring}
            aria-label="Refresh backup list"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Downloaded backups use the <code className="font-mono">.tar.gz</code> format. PrintPartner
          checks an uploaded file before it shows the restore confirmation.
        </p>

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
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      onClick={() => {
                        setError(null);
                        setRestoreFlow({
                          phase: "confirming",
                          target: { kind: "stored", backup },
                        });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Restore
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
                  Restoring replaces the current database and stored files. PrintPartner saves a
                  rollback copy first, then reloads the app.
                </p>
                <div className="flex gap-2 pt-4">
                  <Button
                    onClick={handleRestore}
                    disabled={restoring}
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

import { useCallback, useState, useEffect } from "react";
import { Download, RefreshCw, Trash2, AlertCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface Backup {
  name: string;
  createdAt: string;
  size: number;
}

export default function BackupManagementCard() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const loadBackups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/backups");
      if (!response.ok) throw new Error("Failed to load backups");
      const data = (await response.json()) as Backup[];
      setBackups(data);
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

  const handleRestore = async () => {
    if (!selectedBackup) return;
    setRestoring(true);
    try {
      const response = await fetch("/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupName: selectedBackup }),
      });
      if (!response.ok) throw new Error("Restore failed");
      setShowRestoreDialog(false);
      setError(null);
      // Reload page after successful restore
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this backup? This cannot be undone.")) return;
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

  return (
    <Card>
      <CardHeader>
        <CardTitle level={3}>Backup & Restore</CardTitle>
        <CardDescription>
          Create and manage database backups with automatic rollback protection
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleCreateBackup}
            disabled={loading}
            className="flex-1"
          >
            {loading ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Backup"
            )}
          </Button>
          <Button onClick={loadBackups} variant="outline" disabled={loading}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

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
                        setSelectedBackup(backup.name);
                        setShowRestoreDialog(true);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Restore
                    </Button>
                    <Button
                      onClick={() => handleDelete(backup.name)}
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No backups yet</p>
        )}

        <Dialog open={showRestoreDialog} onOpenChange={setShowRestoreDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Restore from Backup</DialogTitle>
            </DialogHeader>
            <div className="text-sm text-muted-foreground mb-4">
              This will restore the database from a previous backup. A new backup will be created automatically before restoring. The system will restart.
            </div>
            <div className="space-y-4">
              <Select value={selectedBackup || ""} onValueChange={setSelectedBackup}>
                <SelectTrigger>
                  <SelectValue placeholder="Select backup" />
                </SelectTrigger>
                <SelectContent>
                  {backups.map((backup) => (
                    <SelectItem key={backup.name} value={backup.name}>
                      {backup.name} ({formatDate(backup.createdAt)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2 pt-4">
                <Button
                  onClick={handleRestore}
                  disabled={!selectedBackup || restoring}
                  className="flex-1"
                >
                  {restoring ? "Restoring..." : "Restore"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowRestoreDialog(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

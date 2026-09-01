import { useState, useEffect } from "react";
import { Download, RefreshCw, Trash2, AlertCircle } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

interface LoggerConfig {
  minSeverity: "debug" | "info" | "warn" | "error";
  maxLogs: number;
  enableWorkflowTracking: boolean;
}

interface LogStats {
  totalLogs: number;
  byMethod: Record<string, number>;
  bySeverity: Record<string, number>;
  avgDuration: number;
  errorCount: number;
}

interface WorkflowLog {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  duration: number;
  statusCode: number;
  severity: LoggerConfig["minSeverity"];
  message: string;
  context?: unknown;
  error?: unknown;
}

function isSeverity(value: unknown): value is WorkflowLog["severity"] {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function isWorkflowLog(value: unknown): value is WorkflowLog {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value && typeof value.id === "string" &&
    "timestamp" in value && typeof value.timestamp === "string" &&
    "method" in value && typeof value.method === "string" &&
    "url" in value && typeof value.url === "string" &&
    "duration" in value && typeof value.duration === "number" &&
    "statusCode" in value && typeof value.statusCode === "number" &&
    "severity" in value && isSeverity(value.severity) &&
    "message" in value && typeof value.message === "string"
  );
}

function parseWorkflowLogs(value: unknown): WorkflowLog[] {
  if (!Array.isArray(value) || !value.every(isWorkflowLog)) {
    throw new Error("The server returned invalid log data");
  }
  return value;
}

function logDetails(log: WorkflowLog): string | null {
  const details = [
    log.context === undefined ? null : { context: log.context },
    log.error === undefined ? null : { error: log.error },
  ].filter((value) => value !== null);
  return details.length > 0 ? JSON.stringify(Object.assign({}, ...details), null, 2) : null;
}

export default function LoggingManagementCard() {
  const [config, setConfig] = useState<LoggerConfig | null>(null);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [logs, setLogs] = useState<WorkflowLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/settings/logging/config");
      if (!response.ok) throw new Error("Failed to load logging config");
      const data = (await response.json()) as LoggerConfig;
      setConfig(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await fetch("/settings/logging/stats");
      if (!response.ok) throw new Error("Failed to load stats");
      const data = (await response.json()) as LogStats;
      setStats(data);
    } catch (err) {
      // Silent fail for stats — log for diagnostics without surfacing an error to the user.
      console.error("Failed to load logging stats:", err);
    }
  };

  const loadLogs = async () => {
    setLogsLoading(true);
    setError(null);
    try {
      const response = await fetch("/settings/logging/logs?limit=100");
      if (!response.ok) throw new Error("Failed to load recent logs");
      const value: unknown = await response.json();
      setLogs(parseWorkflowLogs(value).slice().reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recent logs");
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
    loadStats();
    loadLogs();
    // Poll stats every 5s, but pause when the tab is hidden
    const interval = setInterval(() => {
      if (document.visibilityState !== "hidden") void loadStats();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleConfigChange = async (newConfig: Partial<LoggerConfig>) => {
    const updated = { ...config, ...newConfig } as LoggerConfig;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/settings/logging/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!response.ok) throw new Error("Failed to update config");
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update config");
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (format: "json" | "jsonl") => {
    try {
      const response = await fetch(
        `/settings/logging/export?format=${format}`
      );
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `logs-${new Date().toISOString()}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  };

  const handleClearLogs = async () => {
    try {
      const response = await fetch("/settings/logging/logs", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Clear failed");
      setLogs([]);
      await loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    }
  };

  if (!config) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle level={3}>Logging & Monitoring</CardTitle>
        <CardDescription>
          Configure logging verbosity and view system workflow statistics
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <div className="flex gap-2 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block">
              Minimum Severity Level
            </label>
            <Select
              value={config.minSeverity}
              onValueChange={(value) =>
                handleConfigChange({
                  minSeverity: value as LoggerConfig["minSeverity"],
                })
              }
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="debug">Debug (most verbose)</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warn">Warn</SelectItem>
                <SelectItem value="error">Error (least verbose)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Only logs at this level or higher will be recorded
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">Workflow Tracking</label>
              <p className="text-xs text-muted-foreground mt-1">
                Track HTTP requests and integration events
              </p>
            </div>
            <Switch
              checked={config.enableWorkflowTracking}
              onCheckedChange={(checked) =>
                handleConfigChange({ enableWorkflowTracking: checked })
              }
              disabled={loading}
            />
          </div>
        </div>

        {stats && (
          <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted p-4">
            <div>
              <p className="text-xs text-muted-foreground">Total Logs</p>
              <p className="text-lg font-semibold">
                {stats.totalLogs}/{config.maxLogs}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Avg Response Time</p>
              <p className="text-lg font-semibold">{stats.avgDuration}ms</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Errors</p>
              <p className="text-lg font-semibold">{stats.errorCount}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Methods</p>
              <p className="text-lg font-semibold">
                {Object.keys(stats.byMethod).length}
              </p>
            </div>
          </div>
        )}

        <section className="space-y-2 border-t pt-4" aria-labelledby="recent-logs-heading">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 id="recent-logs-heading" className="text-sm font-medium">Recent requests</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Latest 100 recorded requests. Open a row to inspect its message and context.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Refresh recent logs"
              disabled={logsLoading}
              onClick={() => void Promise.all([loadLogs(), loadStats()])}
            >
              <RefreshCw className={logsLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </Button>
          </div>
          {logsLoading && logs.length === 0 ? (
            <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
              Loading recent requests…
            </p>
          ) : logs.length === 0 ? (
            <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
              No workflow requests have been recorded yet.
            </p>
          ) : (
            <ul className="max-h-96 space-y-1 overflow-y-auto rounded-md border border-border p-1">
              {logs.map((log) => {
                const details = logDetails(log);
                return (
                  <li key={log.id}>
                    <details className="rounded-md border border-transparent px-2 py-1.5 open:border-border open:bg-muted/40">
                      <summary className="cursor-pointer list-none text-xs">
                        <span className="grid grid-cols-[auto_auto_auto_1fr_auto] items-center gap-2">
                          <time className="whitespace-nowrap text-muted-foreground" dateTime={log.timestamp}>
                            {new Date(log.timestamp).toLocaleString()}
                          </time>
                          <span className="font-mono font-semibold uppercase">{log.method}</span>
                          <span className="font-mono tabular-nums">{log.statusCode}</span>
                          <span className="min-w-0 truncate font-mono" title={log.url}>{log.url}</span>
                          <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                            {Math.round(log.duration)} ms
                          </span>
                        </span>
                      </summary>
                      <div className="space-y-2 px-1 pb-1 pt-2 text-xs">
                        <p>{log.message}</p>
                        <p className="text-muted-foreground">Severity: {log.severity}</p>
                        {details && (
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-micro">
                            {details}
                          </pre>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="space-y-2 pt-4 border-t">
          <p className="text-sm font-medium">Export & Manage</p>
          <div className="flex gap-2">
            <Button
              onClick={() => handleExport("json")}
              variant="outline"
              size="sm"
              className="flex-1"
            >
              <Download className="mr-2 h-4 w-4" />
              Export JSON
            </Button>
            <Button
              onClick={() => handleExport("jsonl")}
              variant="outline"
              size="sm"
              className="flex-1"
            >
              <Download className="mr-2 h-4 w-4" />
              Export JSONL
            </Button>
            <Button
              onClick={() => loadStats()}
              variant="outline"
              size="sm"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <ConfirmDialog
            trigger={
              <Button
                variant="outline"
                size="sm"
                className="w-full text-destructive hover:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Clear All Logs
              </Button>
            }
            title="Clear all logs?"
            description="Every stored log line is deleted from this server. This cannot be undone."
            confirmLabel="Clear all logs"
            onConfirm={() => void handleClearLogs()}
          />
        </div>
      </CardContent>
    </Card>
  );
}

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

export default function LoggingManagementCard() {
  const [config, setConfig] = useState<LoggerConfig | null>(null);
  const [stats, setStats] = useState<LogStats | null>(null);
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

  useEffect(() => {
    loadConfig();
    loadStats();
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
    if (!confirm("Clear all logs? This cannot be undone.")) return;
    try {
      const response = await fetch("/settings/logging/logs", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Clear failed");
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
          <div className="flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
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
          <Button
            onClick={handleClearLogs}
            variant="outline"
            size="sm"
            className="w-full text-red-600 hover:text-red-700"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Clear All Logs
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

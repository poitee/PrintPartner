import { ExternalLink, Trash2 } from "lucide-react";
import type { SlicerDialect, SlicerInstance } from "../../api/endpoints/slicers";
import { isSafeSlicerGuiUrl } from "../../lib/slicerSettingsModel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

export type SlicerDockerAction = "pull" | "start" | "stop" | "logs";

export type SlicerInstancePatch = Partial<{
  name: string;
  gui_url: string;
  watch_path: string;
  dialect: SlicerDialect;
}>;

type SlicerInstanceRowProps = {
  row: SlicerInstance;
  busy: boolean;
  controlsDisabled: boolean;
  dockerEnabled: boolean;
  logs: string[] | undefined;
  onToggle: (row: SlicerInstance, enabled: boolean) => void;
  onSaveField: (row: SlicerInstance, patch: SlicerInstancePatch) => void;
  onDelete: (row: SlicerInstance) => void;
  onDocker: (row: SlicerInstance, action: SlicerDockerAction) => void;
};

export default function SlicerInstanceRow({
  row,
  busy,
  controlsDisabled,
  dockerEnabled,
  logs,
  onToggle,
  onSaveField,
  onDelete,
  onDocker,
}: SlicerInstanceRowProps) {
  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-[12rem]"
          defaultValue={row.name}
          disabled={busy}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next && next !== row.name) onSaveField(row, { name: next });
          }}
        />
        <span className="text-xs text-muted-foreground">{row.kind}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {row.status_cache || "unknown"}
        </span>
        {row.status_message ? (
          <span className="max-w-md text-xs text-destructive" title={row.status_message}>
            {row.status_message}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Enabled</span>
          <Switch
            checked={row.enabled}
            disabled={busy}
            onCheckedChange={(value) => onToggle(row, value)}
          />
          {isSafeSlicerGuiUrl(row.gui_url) ? (
            <Button variant="outline" size="sm" asChild className="gap-1">
              <a href={row.gui_url.trim()} target="_blank" rel="noreferrer noopener">
                Open GUI
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onDelete(row)}
            aria-label={`Delete ${row.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {dockerEnabled ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => onDocker(row, "pull")}
          >
            Pull
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => onDocker(row, "start")}
          >
            Start
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => onDocker(row, "stop")}
          >
            Stop
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => onDocker(row, "logs")}
          >
            Logs
          </Button>
          {row.image ? (
            <span className="self-center font-mono text-xs text-muted-foreground">
              {row.image}
            </span>
          ) : null}
        </div>
      ) : null}
      {logs?.length ? (
        <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-micro leading-snug">
          {logs.join("\n")}
        </pre>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">GUI URL</span>
          <Input
            className="h-8"
            defaultValue={row.gui_url}
            disabled={busy}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== row.gui_url) onSaveField(row, { gui_url: next });
            }}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Watch path</span>
          <Input
            className="h-8 font-mono"
            defaultValue={row.watch_path}
            disabled={busy}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== row.watch_path) onSaveField(row, { watch_path: next });
            }}
          />
        </label>
      </div>
      {row.kind === "custom" ? (
        <label className="block max-w-xs space-y-1 text-xs">
          <span className="text-muted-foreground">Dialect</span>
          <Select
            value={row.dialect}
            onValueChange={(value) => onSaveField(row, { dialect: value as SlicerDialect })}
            disabled={busy}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="orca_json">orca_json</SelectItem>
              <SelectItem value="bambu_json">bambu_json</SelectItem>
              <SelectItem value="prusa_ini">prusa_ini</SelectItem>
            </SelectContent>
          </Select>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">Dialect: {row.dialect}</p>
      )}
    </li>
  );
}

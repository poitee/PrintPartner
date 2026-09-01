import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  createSlicerInstance,
  deleteSlicerInstance,
  fetchSlicerDockerLogs,
  fetchSlicerInstances,
  pullSlicerDocker,
  seedDefaultSlicerInstances,
  startSlicerDocker,
  stopSlicerDocker,
  updateSlicerInstance,
  type SlicerDialect,
  type SlicerInstance,
  type SlicerInstanceKind,
} from "../../api/endpoints/slicers";
import {
  defaultSlicerDialect,
  SLICER_PRESET_KINDS,
  slicerCreatePayloadFromDraft,
} from "../../lib/slicerSettingsModel";
import { useEngineHealth } from "../../hooks/useEngineHealth";
import { Button } from "../ui/button";
import ConfirmDialog from "../ConfirmDialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import SlicerInstanceRow, {
  type SlicerDockerAction,
  type SlicerInstancePatch,
} from "./SlicerInstanceRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type SlicersSettingsCardProps = {
  engineReady: boolean;
};

export default function SlicersSettingsCard({ engineReady }: SlicersSettingsCardProps) {
  const { health } = useEngineHealth();
  const dockerEnabled = health?.deploy_mode !== "saas";
  const [instances, setInstances] = useState<SlicerInstance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SlicerInstance | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logsById, setLogsById] = useState<Record<string, string[]>>({});
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState<SlicerInstanceKind>("orca");
  const [draftDialect, setDraftDialect] = useState<SlicerDialect>("orca_json");
  const [draftGuiUrl, setDraftGuiUrl] = useState("");
  const [draftWatchPath, setDraftWatchPath] = useState("");
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!engineReady) return;
    const generation = ++refreshGeneration.current;
    setLoading(true);
    try {
      const next = await fetchSlicerInstances();
      if (generation !== refreshGeneration.current) return;
      setInstances(next);
      setError(null);
    } catch (e) {
      if (generation !== refreshGeneration.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [engineReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const controlsDisabled = busy || loading || !engineReady;

  const onToggle = async (row: SlicerInstance, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await updateSlicerInstance(row.id, { enabled });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSaveField = async (
    row: SlicerInstance,
    patch: SlicerInstancePatch,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await updateSlicerInstance(row.id, patch);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (row: SlicerInstance) => {
    setBusy(true);
    setError(null);
    try {
      await deleteSlicerInstance(row.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async () => {
    setBusy(true);
    setError(null);
    try {
      await createSlicerInstance(
        slicerCreatePayloadFromDraft({
          name: draftName,
          kind: draftKind,
          dialect: draftDialect,
          guiUrl: draftGuiUrl,
          watchPath: draftWatchPath,
        }),
      );
      setDraftName("");
      setDraftGuiUrl("");
      setDraftWatchPath("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSeed = async () => {
    setBusy(true);
    setError(null);
    try {
      await seedDefaultSlicerInstances();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDocker = async (
    row: SlicerInstance,
    action: SlicerDockerAction,
  ) => {
    setBusy(true);
    setError(null);
    try {
      if (action === "logs") {
        const { lines } = await fetchSlicerDockerLogs(row.id);
        setLogsById((prev) => ({ ...prev, [row.id]: lines }));
      } else {
        const res =
          action === "pull"
            ? await pullSlicerDocker(row.id)
            : action === "start"
              ? await startSlicerDocker(row.id)
              : await stopSlicerDocker(row.id);
        if (res.status.state === "error") {
          setError(res.status.message || "Docker operation failed");
        }
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="slicers" className="shadow-none">
      <CardHeader>
        <CardTitle level={3} className="text-base">Slicers</CardTitle>
        <CardDescription>
          Register slicer GUIs and profile watch paths. Profile sync and Export links use enabled
          instances. Changing watch paths or enablement reloads sync watchers automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConfirmDialog
          open={pendingDelete != null}
          onOpenChange={(next) => {
            if (!next) setPendingDelete(null);
          }}
          title="Delete this slicer?"
          description={
            <>
              “{pendingDelete?.name}” is removed, along with its profile watch
              paths. Profiles already synced into Print Partner stay.
            </>
          }
          confirmLabel="Delete slicer"
          disabled={busy}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            if (target) void onDelete(target);
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}

        {instances.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">No slicer instances yet.</p>
            <Button type="button" size="sm" onClick={() => void onSeed()} disabled={controlsDisabled}>
              Seed defaults (Orca / Prusa / Bambu)
            </Button>
          </div>
        ) : (
          <ul className="space-y-3">
            {instances.map((row) => (
              <SlicerInstanceRow
                key={row.id}
                row={row}
                busy={busy}
                controlsDisabled={controlsDisabled}
                dockerEnabled={dockerEnabled}
                logs={logsById[row.id]}
                onToggle={(slicer, enabled) => void onToggle(slicer, enabled)}
                onSaveField={(slicer, patch) => void onSaveField(slicer, patch)}
                onDelete={(slicer) => setPendingDelete(slicer)}
                onDocker={(slicer, action) => void onDocker(slicer, action)}
              />
            ))}
          </ul>
        )}

        <div className="space-y-2 rounded-md border border-dashed border-border p-3">
          <p className="text-sm font-medium">Add slicer</p>
          <div className="flex flex-wrap gap-2">
            <Select
              value={draftKind}
              onValueChange={(v) => {
                const kind = v as SlicerInstanceKind;
                setDraftKind(kind);
                setDraftDialect(defaultSlicerDialect(kind));
              }}
            >
              <SelectTrigger className="h-8 w-[10rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SLICER_PRESET_KINDS.map((p) => (
                  <SelectItem key={p.kind} value={p.kind}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="h-8 max-w-[12rem]"
              placeholder="Name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
            <Input
              className="h-8 max-w-[14rem]"
              placeholder="GUI URL"
              value={draftGuiUrl}
              onChange={(e) => setDraftGuiUrl(e.target.value)}
            />
            <Input
              className="h-8 max-w-[16rem] font-mono"
              placeholder="Watch path"
              value={draftWatchPath}
              onChange={(e) => setDraftWatchPath(e.target.value)}
            />
            {draftKind === "custom" ? (
              <Select
                value={draftDialect}
                onValueChange={(v) => setDraftDialect(v as SlicerDialect)}
              >
                <SelectTrigger className="h-8 w-[10rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="orca_json">orca_json</SelectItem>
                  <SelectItem value="bambu_json">bambu_json</SelectItem>
                  <SelectItem value="prusa_ini">prusa_ini</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            <Button type="button" size="sm" className="gap-1" disabled={controlsDisabled} onClick={() => void onAdd()}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

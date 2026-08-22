import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Plus, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  startSync,
  type ProfileLayer,
  type SourceSummary,
} from "../../api/engine";
import { sourcesRoute } from "../../lib/routes";
import { useSourcesQuery } from "../../queries/sources";
import { useJobRunner } from "../../hooks/useJobRunner";
import {
  useAddPlanAddonLayerMutation,
  useDeletePlanLayerMutation,
  usePlanLayersQuery,
  useReplacePlanLayerMutation,
  useSetPlanBaseLayerMutation,
} from "../../queries/planLayers";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../ui/sheet";
import { Badge } from "../ui/badge";
import { formatSyncTime } from "../../api/engine";

type Props = {
  profileId: number;
  disabled?: boolean;
};

export default function BuildSourcesPanel({
  profileId,
  disabled,
}: Props) {
  const { data: sources = [] } = useSourcesQuery();
  const { data: layers = [] } = usePlanLayersQuery(profileId);
  const syncJob = useJobRunner("sync");
  const [addonSourceId, setAddonSourceId] = useState("");
  const setBaseMutation = useSetPlanBaseLayerMutation(profileId);
  const addAddonMutation = useAddPlanAddonLayerMutation(profileId);
  const replaceLayerMutation = useReplacePlanLayerMutation(profileId);
  const deleteLayerMutation = useDeletePlanLayerMutation(profileId);
  const busy =
    setBaseMutation.isPending ||
    addAddonMutation.isPending ||
    replaceLayerMutation.isPending ||
    deleteLayerMutation.isPending;

  const attachedIds = useMemo(
    () => new Set(layers.map((l) => l.project_id).filter((id): id is number => id != null)),
    [layers],
  );

  const availableAddons = sources.filter((s) => !attachedIds.has(s.id));

  const syncSource = (sourceId: number) => {
    void syncJob.runJob(
      () => startSync([sourceId]),
      (snap: { status: string; message?: string }) => {
        if (snap.status === "error") toast.error(snap.message || "Sync failed");
        else {
          toast.success("Source synced");
        }
      },
      { sourceIds: [sourceId] },
    );
  };

  const attachBase = async (sourceId: number) => {
    try {
      await setBaseMutation.mutateAsync(sourceId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const attachAddon = async () => {
    const id = Number(addonSourceId);
    if (!Number.isFinite(id) || id <= 0) return;
    try {
      await addAddonMutation.mutateAsync(id);
      setAddonSourceId("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const replaceLayerSource = async (layer: ProfileLayer, sourceId: number) => {
    try {
      await (layer.layer_type === "base"
        ? setBaseMutation.mutateAsync(sourceId)
        : replaceLayerMutation.mutateAsync({ layerId: layer.id, sourceId }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const removeLayer = async (layerId: number) => {
    try {
      await deleteLayerMutation.mutateAsync(layerId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="secondary" size="sm" disabled={disabled}>
          Manage sources
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Plan sources</SheetTitle>
          <SheetDescription>
            Attach repos and sync without leaving Plan.{" "}
            <Link to={sourcesRoute()} className="text-primary underline">
              Full source manager
              <ExternalLink className="ml-0.5 inline h-3 w-3" />
            </Link>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {layers.map((layer) => (
            <div key={layer.id} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={layer.layer_type === "base" ? "base" : "addon"}>
                  {layer.layer_type}
                </Badge>
                {layer.layer_type === "addon" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void removeLayer(layer.id)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <SourceRowSelect
                sources={sources}
                value={layer.project_id}
                disabled={busy || disabled}
                onChange={(id) => void replaceLayerSource(layer, id)}
              />
              {layer.project_id != null && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={syncJob.isBusyForSource(layer.project_id)}
                  onClick={() => syncSource(layer.project_id!)}
                >
                  <RefreshCw
                    className={`mr-1.5 h-3.5 w-3.5 ${
                      syncJob.isBusyForSource(layer.project_id) ? "animate-spin" : ""
                    }`}
                  />
                  Sync
                </Button>
              )}
            </div>
          ))}

          {!layers.some((l) => l.layer_type === "base") && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Base source</p>
              <SourceRowSelect
                sources={sources}
                value={null}
                disabled={busy || disabled}
                onChange={(id) => void attachBase(id)}
                placeholder="Select base source…"
              />
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium">Add add-on layer</p>
            <div className="flex gap-2">
              <Select
                value={addonSourceId}
                onValueChange={setAddonSourceId}
                disabled={busy || availableAddons.length === 0}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select source…" />
                </SelectTrigger>
                <SelectContent>
                  {availableAddons.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon"
                disabled={busy || !addonSourceId}
                onClick={() => void attachAddon()}
                aria-label="Add layer"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SourceRowSelect({
  sources,
  value,
  onChange,
  disabled,
  placeholder = "Select source…",
}: {
  sources: SourceSummary[];
  value: number | null;
  onChange: (id: number) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Select
      value={value != null ? String(value) : ""}
      onValueChange={(v) => onChange(Number(v))}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {sources.map((s) => (
          <SelectItem key={s.id} value={String(s.id)}>
            {s.name}
            {s.last_synced_at ? ` · ${formatSyncTime(s.last_synced_at)}` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

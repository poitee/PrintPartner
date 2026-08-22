import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  fetchSlicerInstances,
  type SlicerInstance,
} from "../../api/engine";
import {
  acceptedPlateErrorCode,
  fetchAcceptedPlateSlicerExchangeStatus,
  isAcceptedPlateStaleError,
  openAcceptedPlatesInSlicer,
  startAcceptedPlateExport,
} from "../../api/endpoints/acceptedPlates";
import { useProfileSelection } from "../../context/ProfileContext";
import { useEngineHealth } from "../../hooks/useEngineHealth";
import { useJobRunner } from "../../hooks/useJobRunner";
import { downloadAcceptedPlateExport } from "../../lib/acceptedPlateExportResult";
import { settingsRoute } from "../../lib/routes";
import {
  acceptedPlateCapability,
  invalidateAcceptedPlateWorkspace,
  useAcceptedPlateRevisionPending,
  useAcceptedPlateWorkspaceQuery,
} from "../../queries/acceptedPlates";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type ManagedSlicerPopup = Readonly<{
  navigate: (url: string) => void;
  close: () => void;
}>;

type ManagedSlicerOpenResult =
  | { readonly kind: "opened" }
  | { readonly kind: "manual"; readonly guiUrl: string };

function reserveManagedSlicerPopup(): ManagedSlicerPopup | null {
  let popup: Window | null = null;
  try {
    popup = window.open("about:blank", "_blank");
    if (!popup) return null;
    popup.opener = null;
    return {
      navigate: (url) => popup?.location.replace(url),
      close: () => popup?.close(),
    };
  } catch {
    popup?.close();
    return null;
  }
}

export function completeManagedSlicerOpen(
  popup: ManagedSlicerPopup | null,
  guiUrl: string,
): ManagedSlicerOpenResult {
  if (!popup) return { kind: "manual", guiUrl };
  try {
    popup.navigate(guiUrl);
    return { kind: "opened" };
  } catch {
    popup.close();
    return { kind: "manual", guiUrl };
  }
}

function handoffFailureMessage(error: unknown): string {
  switch (acceptedPlateErrorCode(error)) {
    case "output_conflict":
      return "The stored accepted Plate export failed integrity verification.";
    case "slicer_exchange_unavailable":
      return "The managed slicer exchange is unavailable. Download the 3MF instead.";
    case "accepted_artifact_unavailable":
      return "A verified accepted Plate artifact is unavailable.";
    case "internal_error":
      return "Accepted Plate handoff failed inside PrintPartner.";
    default:
      return error instanceof Error ? error.message : "Accepted Plate handoff failed.";
  }
}

export default function SlicerHandoffPanel() {
  const { health } = useEngineHealth();
  const { selectedProfileId } = useProfileSelection();
  const queryClient = useQueryClient();
  const workspaceQuery = useAcceptedPlateWorkspaceQuery(selectedProfileId, Boolean(health?.ok));
  const revisionWritePending = useAcceptedPlateRevisionPending(selectedProfileId);
  const exportJob = useJobRunner("export-accepted-plate-3mf", selectedProfileId);
  const [instances, setInstances] = useState<SlicerInstance[]>([]);
  const [instanceId, setInstanceId] = useState("");
  const [exchangeStatus, setExchangeStatus] = useState<"ready" | "not_configured" | "unavailable">("unavailable");
  const [handoffPending, setHandoffPending] = useState(false);
  const [manualGuiUrl, setManualGuiUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!health?.ok) return;
    let cancelled = false;
    void Promise.all([fetchSlicerInstances(), fetchAcceptedPlateSlicerExchangeStatus()])
      .then(([list, exchange]) => {
        if (cancelled) return;
        const enabled = list.filter((instance) => instance.enabled && instance.gui_url.trim());
        setInstances(enabled);
        setInstanceId((current) => current || enabled[0]?.id || "");
        setExchangeStatus(exchange.code);
      })
      .catch(() => {
        if (!cancelled) {
          setInstances([]);
          setExchangeStatus("unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [health?.ok]);

  const capability = acceptedPlateCapability({
    enabled: Boolean(health?.ok),
    profileId: selectedProfileId,
    workspace: workspaceQuery.data,
    isPending: workspaceQuery.isPending,
    isError: workspaceQuery.isError,
    revisionWritePending,
  });
  const disabled = capability.kind !== "ready" || exportJob.busy || handoffPending;

  const exportAndDownload = async (localApp: boolean) => {
    if (capability.kind !== "ready") return;
    if (localApp) {
      toast.info(
        "Your browser will download the accepted Plate export. Extract it if needed, then open the 3MF files in your local slicer.",
      );
    }
    await exportJob.runJob(
      () => startAcceptedPlateExport({
        profile_id: capability.profileId,
        expected_plate_revision_id: capability.plateRevisionId,
      }),
      (snapshot) => {
        const downloaded = downloadAcceptedPlateExport(snapshot);
        if (downloaded.kind === "invalid_result") {
          toast.error("PrintPartner returned an invalid accepted Plate export.");
        } else if (downloaded.kind === "job_failed") {
          toast.error(snapshot.error || "Accepted Plate export failed.");
        }
      },
      { profileId: capability.profileId },
    );
  };

  const managedOpen = async () => {
    if (capability.kind !== "ready" || !instanceId) return;
    const popup = reserveManagedSlicerPopup();
    setManualGuiUrl(null);
    setHandoffPending(true);
    try {
      const result = await openAcceptedPlatesInSlicer(instanceId, {
        profile_id: capability.profileId,
        expected_plate_revision_id: capability.plateRevisionId,
      });
      toast.success("Accepted Plates staged for the slicer", {
        description: result.inbox_relative_path,
      });
      const opened = completeManagedSlicerOpen(popup, result.gui_url);
      if (opened.kind === "manual") setManualGuiUrl(opened.guiUrl);
    } catch (error) {
      popup?.close();
      if (isAcceptedPlateStaleError(error)) {
        await invalidateAcceptedPlateWorkspace(queryClient, capability.profileId);
        toast.error("Newer accepted Plate state replaced this handoff request.");
      } else {
        toast.error(handoffFailureMessage(error));
      }
    } finally {
      setHandoffPending(false);
    }
  };

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="gap-1 pb-2">
        <CardTitle level={3} className="text-[13.5px] font-semibold leading-snug">
          Export accepted Plates
        </CardTitle>
        <CardDescription className="text-[12.5px] leading-relaxed">
          Export and slicer handoff use the saved Plate revision shown above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {instances.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No managed slicer is enabled. <Link className="underline" to={`${settingsRoute()}#slicers`}>Open Slicer settings</Link>
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Managed slicer</span>
            <Select value={instanceId} onValueChange={setInstanceId}>
              <SelectTrigger className="h-8 w-[14rem]">
                <SelectValue placeholder="Choose slicer" />
              </SelectTrigger>
              <SelectContent>
                {instances.map((instance) => (
                  <SelectItem key={instance.id} value={instance.id}>{instance.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={disabled} loading={exportJob.busy} onClick={() => void exportAndDownload(false)}>
            Download 3MF
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !instanceId || exchangeStatus !== "ready"}
            loading={handoffPending}
            onClick={() => void managedOpen()}
          >
            Open in managed slicer
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void exportAndDownload(true)}>
            Download for local slicer
          </Button>
        </div>
        {manualGuiUrl ? (
          <a
            className="text-sm font-medium text-primary underline"
            href={manualGuiUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the managed slicer manually
          </a>
        ) : null}
        {exchangeStatus !== "ready" ? (
          <p className="text-xs text-muted-foreground">
            {exchangeStatus === "not_configured"
              ? "Managed slicer handoff is not configured. Download still works."
              : "Managed slicer handoff is unavailable. Download still works."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

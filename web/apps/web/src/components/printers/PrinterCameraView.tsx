import { useCallback, useState } from "react";
import { Camera, RefreshCw } from "lucide-react";
import type { PrinterCamera } from "@print-partner/contracts";
import type { IntegrationSummary } from "../../api/endpoints/integrations";
import {
  fetchPrinterCameras,
  printerCameraViewUrl,
  type PrinterMachine,
} from "../../api/endpoints/printers";
import { Button } from "../ui/button";
import InlineOperationError from "./InlineOperationError";
import { useAsyncView } from "./asyncView";

type Props = {
  printer: PrinterMachine;
  host: IntegrationSummary | null;
};

/**
 * Camera discovery and viewing for one printer.
 *
 * Split out of the workspace sheet because it changes for camera reasons:
 * a new stream type, a new host quirk. None of that touches print files.
 */
export default function PrinterCameraView({ printer, host }: Props) {
  const request = useCallback(() => fetchPrinterCameras(printer.id), [printer.id]);
  const { view, reload } = useAsyncView({
    request,
    fallbackMessage: "The host did not answer the camera request.",
  });
  const [selectedId, setSelectedId] = useState("");
  const [revision, setRevision] = useState(0);

  if (view.status === "loading") {
    return (
      <p className="text-body text-muted-foreground" role="status">
        Discovering cameras on {printer.name}…
      </p>
    );
  }

  if (view.status === "failed") {
    return (
      <InlineOperationError
        title={`Could not discover cameras on ${printer.name}`}
        message={view.message}
        onRetry={reload}
        retryLabel="Try again"
      />
    );
  }

  const cameras = view.data;
  if (cameras.length === 0) return <NoCameras host={host} onRetry={reload} />;

  const selected = cameras.find((camera) => camera.id === selectedId) ?? cameras[0];

  return (
    <div className="stack-section">
      <div className="flex flex-wrap items-center gap-2">
        <Camera className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <select
          className="min-h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-body"
          aria-label={`Camera on ${printer.name}`}
          value={selected.id}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {cameras.map((camera) => (
            <option key={camera.id} value={camera.id}>
              {camera.name}
            </option>
          ))}
        </select>
        <Button
          size="shop"
          variant="outline"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
          Refresh
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface-sunken">
        <img
          key={`${selected.id}:${revision}`}
          src={`${printerCameraViewUrl(printer.id, selected.id)}&revision=${revision}`}
          alt={`${selected.name} view of ${printer.name}`}
          className="aspect-video w-full object-contain"
        />
      </div>
      <p className="text-meta text-muted-foreground">
        {viewCaption(selected)}
      </p>
    </div>
  );
}

function viewCaption(camera: PrinterCamera): string {
  switch (camera.view) {
    case "mjpeg":
      return "Live view, proxied through PrintPartner so the host credentials stay on the server.";
    case "snapshot":
      return "Snapshot view. Refresh for a current image.";
    default: {
      const _exhaustive: never = camera.view;
      return _exhaustive;
    }
  }
}

/**
 * A host that answered with no cameras.
 *
 * Not a failure, so it gets no error styling, but it still names who owns the
 * next step: PrusaLink's BuddyCam is RTSP and a browser cannot play it, so the
 * route out is Prusa Connect rather than a retry.
 */
function NoCameras({
  host,
  onRetry,
}: {
  host: IntegrationSummary | null;
  onRetry: () => void;
}) {
  return (
    <div className="stack-row rounded-md border border-dashed border-border-strong p-4">
      <p className="text-body text-muted-foreground">
        This host reported no camera a browser can show.
      </p>
      {host?.type === "prusalink" ? (
        <>
          <p className="text-meta text-muted-foreground">
            BuddyCam publishes a LAN-only, unencrypted RTSP stream, which a browser cannot play
            directly. Use Prusa Connect for BuddyCam video. PrusaLink cameras show up here as
            snapshots.
          </p>
          <Button size="shop" variant="outline" asChild>
            <a href="https://connect.prusa3d.com/" target="_blank" rel="noreferrer">
              Open Prusa Connect
            </a>
          </Button>
        </>
      ) : (
        <>
          <p className="text-meta text-muted-foreground">
            Add the camera in Moonraker, Mainsail, or Fluidd, then look again.
          </p>
          <Button size="shop" variant="outline" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            Look again
          </Button>
        </>
      )}
    </div>
  );
}

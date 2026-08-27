import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, FileCode2, FolderOpen, RefreshCw, Upload } from "lucide-react";
import type { PrinterCamera, PrinterStoredFile, ProfileSummary } from "@print-partner/contracts";
import { toast } from "sonner";
import {
  assignPrinterFile,
  completeManualPrinterFile,
  type PrinterCheckoffLink,
} from "../../api/endpoints/checkoff";
import {
  fetchPrinterCameras,
  fetchPrinterStoredFiles,
  openPrinterStoredFile,
  printerCameraViewUrl,
  type PrinterMachine,
} from "../../api/endpoints/printers";
import type { IntegrationSummary } from "../../api/endpoints/integrations";
import {
  parseSlicedObjectsFile,
  type ParseSlicedObjectsResult,
} from "../../lib/parseSlicedObjects";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  printer: PrinterMachine;
  host: IntegrationSummary | null;
  profiles: ProfileSummary[];
  selectedProfileId: number | null;
  links: PrinterCheckoffLink[];
  onChanged: () => void;
};

type ChosenFile = {
  file: File;
  remotePath?: string;
  parsed: ParseSlicedObjectsResult;
};

function allowedPrintFile(filename: string): boolean {
  return /\.(?:gcode|gco|bgcode|3mf)$/i.test(filename);
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return "Size unavailable";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function shortDate(value?: string): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export default function PrinterWorkspaceSheet({
  open,
  onOpenChange,
  printer,
  host,
  profiles,
  selectedProfileId,
  links,
  onChanged,
}: Props) {
  const hostCanBrowse = host?.type === "moonraker" || host?.type === "prusalink";
  const hostCanShowCamera = host?.type === "moonraker" || host?.type === "prusalink";
  const localInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState("files");
  const [source, setSource] = useState<"printer" | "computer">(
    hostCanBrowse ? "printer" : "computer",
  );
  const [storedFiles, setStoredFiles] = useState<PrinterStoredFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<PrinterCamera[]>([]);
  const [camerasLoading, setCamerasLoading] = useState(false);
  const [camerasError, setCamerasError] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [cameraRevision, setCameraRevision] = useState(0);
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [parseBusy, setParseBusy] = useState(false);
  const [profileId, setProfileId] = useState(
    selectedProfileId == null ? "" : String(selectedProfileId),
  );
  const [tracking, setTracking] = useState<"host" | "manual">(
    host ? "host" : "manual",
  );
  const [completed, setCompleted] = useState(false);
  const [confirmedSliced3mf, setConfirmedSliced3mf] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [finishingId, setFinishingId] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    if (!hostCanBrowse) return;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const rows = await fetchPrinterStoredFiles(printer.id);
      setStoredFiles(
        [...rows].sort((a, b) => (b.modified_at ?? "").localeCompare(a.modified_at ?? "")),
      );
    } catch (error) {
      setStoredFiles([]);
      setFilesError(error instanceof Error ? error.message : "Could not load printer files");
    } finally {
      setFilesLoading(false);
    }
  }, [hostCanBrowse, printer.id]);

  const loadCameras = useCallback(async () => {
    if (!hostCanShowCamera) return;
    setCamerasLoading(true);
    setCamerasError(null);
    try {
      const rows = await fetchPrinterCameras(printer.id);
      setCameras(rows);
      setSelectedCameraId((current) =>
        rows.some((camera) => camera.id === current) ? current : rows[0]?.id ?? "",
      );
    } catch (error) {
      setCameras([]);
      setCamerasError(error instanceof Error ? error.message : "Could not load cameras");
    } finally {
      setCamerasLoading(false);
    }
  }, [hostCanShowCamera, printer.id]);

  useEffect(() => {
    if (!open) return;
    setTab("files");
    setSource(hostCanBrowse ? "printer" : "computer");
    setTracking(host ? "host" : "manual");
    setProfileId(selectedProfileId == null ? "" : String(selectedProfileId));
    setChosen(null);
    setCompleted(false);
    setConfirmedSliced3mf(false);
    if (hostCanBrowse) void loadFiles();
    else setStoredFiles([]);
    if (hostCanShowCamera) {
      void loadCameras();
    } else {
      setCameras([]);
    }
  }, [
    open,
    printer.id,
    host,
    hostCanBrowse,
    hostCanShowCamera,
    loadFiles,
    loadCameras,
    selectedProfileId,
  ]);

  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) ?? null;
  const printerLinks = useMemo(
    () => links.filter((link) => link.printer_id === printer.id),
    [links, printer.id],
  );
  const openManualLinks = printerLinks.filter(
    (link) => link.state === "watching" && link.integration_id === `manual:${printer.id}`,
  );

  const parseFile = async (file: File, remotePath?: string) => {
    if (!allowedPrintFile(file.name)) {
      toast.error("Choose a sliced .gcode, .gco, .bgcode, or .3mf file");
      return;
    }
    setParseBusy(true);
    try {
      const parsed = await parseSlicedObjectsFile(file);
      setChosen({ file, remotePath, parsed });
      setConfirmedSliced3mf(false);
    } catch (error) {
      toast.error("Could not inspect the print file", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setParseBusy(false);
    }
  };

  const chooseStoredFile = async (storedFile: PrinterStoredFile) => {
    setParseBusy(true);
    try {
      const file = await openPrinterStoredFile(printer.id, storedFile);
      const parsed = await parseSlicedObjectsFile(file);
      setChosen({ file, remotePath: storedFile.path, parsed });
      setConfirmedSliced3mf(false);
    } catch (error) {
      toast.error("Could not open the printer file", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setParseBusy(false);
    }
  };

  const assign = async () => {
    if (!chosen) return;
    if (chosen.parsed.format === "3mf" && !confirmedSliced3mf) {
      toast.error("Confirm that this 3MF contains sliced, print-ready toolpaths");
      return;
    }
    const buildId = Number(profileId);
    if (!Number.isInteger(buildId) || buildId <= 0) {
      toast.error("Choose the Build this print belongs to");
      return;
    }
    setAssigning(true);
    try {
      const result = await assignPrinterFile({
        profile_id: buildId,
        printer_id: printer.id,
        filename: chosen.file.name,
        remote_path: chosen.remotePath,
        object_names: chosen.parsed.names,
        tracking,
        completed,
        ...(chosen.parsed.format === "3mf" ? { sliced_3mf_confirmed: true } : {}),
      });
      toast.success(
        completed
          ? `${chosen.file.name} is ready for Checkoff`
          : `${chosen.file.name} is assigned to this Build`,
        {
          description: result.link.units.length > 0
            ? `${result.link.units.length} Required unit${result.link.units.length === 1 ? "" : "s"} matched.`
            : undefined,
        },
      );
      setChosen(null);
      setCompleted(false);
      setConfirmedSliced3mf(false);
      onChanged();
      setTab("tracked");
    } catch (error) {
      toast.error("Could not assign the print file", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAssigning(false);
    }
  };

  const finishManual = async (link: PrinterCheckoffLink) => {
    setFinishingId(link.id);
    try {
      await completeManualPrinterFile(link.id);
      toast.success(`${link.filename} is ready for Checkoff`);
      onChanged();
    } catch (error) {
      toast.error("Could not finish the tracked print", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFinishingId(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{printer.name}</SheetTitle>
          <SheetDescription>
            Find or provide a print file, assign it to a Build, and keep its Checkoff attached.
          </SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-4 mt-4 grid w-auto grid-cols-3">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="camera">Camera</TabsTrigger>
            <TabsTrigger value="tracked">
              Tracked{openManualLinks.length > 0 ? ` (${openManualLinks.length})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="files" className="mt-0 space-y-4 p-4">
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-sm font-medium">Where is the file?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {hostCanBrowse ? (
                  <Button
                    size="sm"
                    variant={source === "printer" ? "default" : "outline"}
                    onClick={() => setSource("printer")}
                  >
                    <FolderOpen className="mr-1.5 h-4 w-4" aria-hidden />
                    On this printer
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={source === "computer" ? "default" : "outline"}
                  onClick={() => setSource("computer")}
                >
                  <Upload className="mr-1.5 h-4 w-4" aria-hidden />
                  From this computer
                </Button>
              </div>
            </div>

            {source === "printer" && hostCanBrowse ? (
              <section aria-label="Files on printer" className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Files on {printer.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      Open a stored file to inspect its object labels before assignment.
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void loadFiles()} disabled={filesLoading}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Refresh
                  </Button>
                </div>
                {filesError ? <p className="text-sm text-destructive" role="alert">{filesError}</p> : null}
                {filesLoading ? (
                  <p className="text-sm text-muted-foreground" role="status">Loading printer files…</p>
                ) : storedFiles.length === 0 ? (
                  <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No sliced files were returned by this printer host.
                  </p>
                ) : (
                  <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {storedFiles.map((file) => (
                      <li key={file.id} className="flex items-center gap-3 p-3">
                        <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium" title={file.path}>{file.filename}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {file.path} · {formatBytes(file.size_bytes)} · {shortDate(file.modified_at)}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={parseBusy}
                          onClick={() => void chooseStoredFile(file)}
                        >
                          Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : (
              <section className="space-y-2" aria-label="Provide a print file">
                <input
                  ref={localInputRef}
                  type="file"
                  className="hidden"
                  accept=".gcode,.gco,.bgcode,.3mf,application/octet-stream"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void parseFile(file);
                  }}
                />
                <Button variant="outline" disabled={parseBusy} onClick={() => localInputRef.current?.click()}>
                  <Upload className="mr-1.5 h-4 w-4" aria-hidden />
                  {parseBusy ? "Inspecting…" : "Choose .gcode, .bgcode, or .3mf"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Use this for SD-card, USB, cloud, or other printers PrintPartner cannot monitor.
                  A .3mf must already be sliced and print-ready.
                </p>
              </section>
            )}

            {chosen ? (
              <section className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-4" aria-label="Assign print file">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{chosen.file.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {chosen.parsed.names.length > 0
                        ? `${chosen.parsed.names.length} object label${chosen.parsed.names.length === 1 ? "" : "s"} found`
                        : "No object labels found; PrintPartner will try the filename."}
                    </p>
                  </div>
                  <Badge variant="muted">{chosen.parsed.format}</Badge>
                </div>

                {chosen.parsed.names.length > 0 ? (
                  <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-background p-2">
                    <ul className="space-y-1 font-mono text-xs">
                      {chosen.parsed.names.map((name) => <li key={name} className="truncate">{name}</li>)}
                    </ul>
                  </div>
                ) : null}

                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Assign to Build</span>
                  <select
                    className="min-h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={profileId}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    <option value="">Choose a Build…</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                </label>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">How should PrintPartner track it?</legend>
                  {host ? (
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name={`tracking-${printer.id}`}
                        checked={tracking === "host"}
                        onChange={() => setTracking("host")}
                      />
                      <span>
                        <span className="block font-medium">Watch this printer</span>
                        <span className="block text-xs text-muted-foreground">
                          Match the filename when the host reports the current or next print.
                        </span>
                      </span>
                    </label>
                  ) : null}
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={`tracking-${printer.id}`}
                      checked={tracking === "manual"}
                      onChange={() => setTracking("manual")}
                    />
                    <span>
                      <span className="block font-medium">Track manually</span>
                      <span className="block text-xs text-muted-foreground">
                        Use Tracked prints to mark it finished when the printer cannot report status.
                      </span>
                    </span>
                  </label>
                </fieldset>

                {chosen.parsed.format === "3mf" ? (
                  <label className="flex items-start gap-2 rounded-md border border-warning/35 bg-warning-soft p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmedSliced3mf}
                      onChange={(event) => setConfirmedSliced3mf(event.target.checked)}
                    />
                    <span>
                      <span className="block font-medium">This 3MF is already sliced and print-ready</span>
                      <span className="block text-xs text-muted-foreground">
                        A model/project 3MF still needs slicing and cannot be tracked as a print file.
                      </span>
                    </span>
                  </label>
                ) : null}

                <label className="flex items-start gap-2 rounded-md border border-border bg-background p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={completed}
                    onChange={(event) => setCompleted(event.target.checked)}
                  />
                  <span>
                    <span className="block font-medium">This print is already finished</span>
                    <span className="block text-xs text-muted-foreground">
                      Send it directly to Checkoff instead of waiting for a host or manual finish.
                    </span>
                  </span>
                </label>

                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" onClick={() => setChosen(null)} disabled={assigning}>Cancel</Button>
                  <Button
                    onClick={() => void assign()}
                    disabled={
                      assigning ||
                      !profileId ||
                      (chosen.parsed.format === "3mf" && !confirmedSliced3mf)
                    }
                  >
                    {assigning ? "Assigning…" : completed ? "Assign and send to Checkoff" : "Assign print file"}
                  </Button>
                </div>
              </section>
            ) : null}
          </TabsContent>

          <TabsContent value="camera" className="mt-0 space-y-4 p-4">
            {!hostCanShowCamera ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                {host?.type === "bambu"
                  ? "Use the Bambu app or Bambu Studio for this printer's camera."
                  : "Link a Moonraker or PrusaLink host to discover its cameras."}
              </p>
            ) : camerasLoading ? (
              <p className="text-sm text-muted-foreground" role="status">Discovering cameras…</p>
            ) : camerasError ? (
              <p className="text-sm text-destructive" role="alert">{camerasError}</p>
            ) : cameras.length === 0 ? (
              <div className="space-y-3 rounded-md border border-dashed p-4">
                <p className="text-sm text-muted-foreground">No browser-compatible camera was reported by this host.</p>
                {host.type === "prusalink" ? (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      BuddyCam exposes a local RTSP stream, which browsers cannot play directly. Use Prusa Connect for BuddyCam video; PrusaLink cameras appear here as snapshots.
                    </p>
                    <Button size="sm" variant="outline" asChild>
                      <a href="https://connect.prusa3d.com/" target="_blank" rel="noreferrer">
                        Open Prusa Connect
                      </a>
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Configure the camera in Moonraker/Mainsail/Fluidd, then refresh this view.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Camera className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <select
                    className="min-h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    aria-label="Printer camera"
                    value={selectedCameraId}
                    onChange={(event) => setSelectedCameraId(event.target.value)}
                  >
                    {cameras.map((camera) => (
                      <option key={camera.id} value={camera.id}>{camera.name}</option>
                    ))}
                  </select>
                  <Button size="sm" variant="outline" onClick={() => setCameraRevision((value) => value + 1)}>
                    Refresh
                  </Button>
                </div>
                {selectedCamera ? (
                  <div className="overflow-hidden rounded-lg border border-border bg-black">
                    <img
                      key={`${selectedCamera.id}:${cameraRevision}`}
                      src={`${printerCameraViewUrl(printer.id, selectedCamera.id)}&revision=${cameraRevision}`}
                      alt={`${selectedCamera.name} view for ${printer.name}`}
                      className="aspect-video w-full object-contain"
                    />
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {selectedCamera?.view === "mjpeg"
                    ? "Live MJPEG view proxied through PrintPartner so host credentials stay private."
                    : "Snapshot view. Refresh for a current image."}
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="tracked" className="mt-0 space-y-3 p-4">
            {printerLinks.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No print files are assigned to this printer yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {printerLinks.map((link) => {
                  const manualWaiting =
                    link.state === "watching" && link.integration_id === `manual:${printer.id}`;
                  return (
                    <li key={link.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{link.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {profiles.find((profile) => profile.id === link.profile_id)?.name ?? `Build ${link.profile_id}`}
                          {" · "}{link.state.replaceAll("_", " ")}
                          {" · "}{link.units.length} Required unit{link.units.length === 1 ? "" : "s"}
                        </p>
                      </div>
                      {manualWaiting ? (
                        <Button
                          size="sm"
                          onClick={() => void finishManual(link)}
                          disabled={finishingId === link.id}
                        >
                          {finishingId === link.id ? "Finishing…" : "Mark finished"}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

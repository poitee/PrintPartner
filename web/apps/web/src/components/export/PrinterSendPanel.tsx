import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchIntegrationStatus, fetchIntegrations } from "../../api/endpoints/integrations";
import { fetchPrinters, type PrinterMachine } from "../../api/endpoints/printers";
import {
  bambuConnectDownloadUrl,
  startBambuConnectHandoff,
  startPrinterUpload,
} from "../../api/endpoints/productionSend";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { PrinterHostStatus } from "@print-partner/contracts";
import { useJobRunner } from "../../hooks/useJobRunner";
import {
  parseSlicedObjectsFile,
  type ParseSlicedObjectsResult,
} from "../../lib/parseSlicedObjects";
import {
  buildObjectPreviewRows,
  proposeCheckoffFromObjects,
  type ProposeCheckoffResult,
} from "../../lib/proposeCheckoffFromObjects";
import { printerHostTypeLabel, type LiveStripHostType } from "../../lib/printerLiveStrip";
import {
  isAllowedBambuConnectFile,
  isAllowedGcode,
  partitionPrinterSendFleet,
  printerSendStatusLabel,
  printerSendStatusVariant,
  resolveStickyPrinterId,
} from "../../lib/printerSendModel";
import { usePrinterStatusPollMs } from "../../hooks/usePrinterStatusPollMs";
import { settingsPrintersRoute } from "../../lib/routes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import ObjectProposalRows from "./ObjectProposalRows";
import PlateApprovalCard from "./PlateApprovalCard";
import {
  sendPlanBindCopy,
} from "../../lib/printerPlanBind";
import { readStickyId, writeStickyId } from "../../lib/stickyIdStorage";

const PRINTER_ID_STORAGE_KEY = "pp-export-printer-id";
const BAMBU_PRINTER_ID_STORAGE_KEY = "pp-export-bambu-printer-id";

/** A recoverable send failure. Retry reruns the send with the same file. */
export type PrinterSendFailure = Readonly<{ message: string; retry: () => void }>;

type Props = {
  /** Remaining incomplete review parts for local object → unit proposal. */
  remainingParts: ReviewPart[];
  profileId: number | null;
  /** Active spine plan name for quiet “For [Plan].” bind line. */
  planName?: string | null;
  engineReady: boolean;
  /** Reports the sliced file the work package is holding, or null when cleared. */
  onSlicedFileChange?: (file: Readonly<{ name: string }> | null) => void;
  /** Reports the current recoverable send failure for the Production task list. */
  onFailure?: (failure: PrinterSendFailure | null) => void;
};

export default function PrinterSendPanel({
  remainingParts,
  profileId,
  planName = null,
  engineReady,
  onSlicedFileChange,
  onFailure,
}: Props) {
  const printerUploadJob = useJobRunner("printer-upload");
  const pollMs = usePrinterStatusPollMs();
  const planBind = sendPlanBindCopy(planName ?? null);

  const [linkedPrinters, setLinkedPrinters] = useState<PrinterMachine[]>([]);
  const [bambuPrinters, setBambuPrinters] = useState<PrinterMachine[]>([]);
  const [hostTypeByPrinterId, setHostTypeByPrinterId] = useState<
    Record<string, LiveStripHostType>
  >({});
  const [selectedPrinterId, setSelectedPrinterId] = useState(
    () => readStickyId(PRINTER_ID_STORAGE_KEY),
  );
  const [selectedBambuPrinterId, setSelectedBambuPrinterId] = useState(
    () => readStickyId(BAMBU_PRINTER_ID_STORAGE_KEY),
  );
  const [hostStatusByIntegration, setHostStatusByIntegration] = useState<
    Record<string, PrinterHostStatus>
  >({});
  const [chosenFile, setChosenFileState] = useState<File | null>(null);
  const [sendFailure, setSendFailureState] = useState<PrinterSendFailure | null>(null);
  const [objectParse, setObjectParse] = useState<ParseSlicedObjectsResult | null>(null);
  const [objectPropose, setObjectPropose] = useState<ProposeCheckoffResult | null>(null);
  const [parseBusy, setParseBusy] = useState(false);
  const [bambuBusy, setBambuBusy] = useState(false);
  const [printersLoading, setPrintersLoading] = useState(true);

  /**
   * The sliced file is the work package's handoff back from the slicer, so the
   * page above needs to know it arrived. Reported from event handlers only.
   */
  const setChosenFile = (file: File | null) => {
    setChosenFileState(file);
    onSlicedFileChange?.(file ? { name: file.name } : null);
  };

  /**
   * A send that does not reach the printer stays on the page beside the task it
   * broke. Retry reruns the same upload with the same file and printer.
   */
  const setSendFailure = (failure: PrinterSendFailure | null) => {
    setSendFailureState(failure);
    onFailure?.(failure);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bambuFileInputRef = useRef<HTMLInputElement>(null);
  const pendingActionRef = useRef<"send" | "start" | null>(null);
  const parseGenRef = useRef(0);

  const hasLinked = linkedPrinters.length > 0;
  const hasBambuLinked = bambuPrinters.length > 0;
  const busy = printerUploadJob.busy || bambuBusy || parseBusy;

  useEffect(() => {
    if (!engineReady) return;
    let cancelled = false;
    setPrintersLoading(true);
    void (async () => {
      try {
        const [printers, integrations] = await Promise.all([
          fetchPrinters(),
          fetchIntegrations(),
        ]);
        if (cancelled) return;
        const fleet = partitionPrinterSendFleet(printers, integrations);
        setLinkedPrinters(fleet.sendPrinters);
        setBambuPrinters(fleet.bambuPrinters);
        setHostTypeByPrinterId(fleet.hostTypeByPrinterId);
        const stickySend = readStickyId(PRINTER_ID_STORAGE_KEY);
        const stickyBambu = readStickyId(BAMBU_PRINTER_ID_STORAGE_KEY);
        setSelectedPrinterId((prev) =>
          resolveStickyPrinterId(fleet.sendPrinters, stickySend, prev),
        );
        setSelectedBambuPrinterId((prev) =>
          resolveStickyPrinterId(fleet.bambuPrinters, stickyBambu, prev),
        );
      } catch {
        if (cancelled) return;
        setLinkedPrinters([]);
        setBambuPrinters([]);
      } finally {
        if (!cancelled) setPrintersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engineReady]);

  // Poll host status for badges only — do NOT auto-drain the farm send queue while
  // Export is open. Queue drain/dispatch is Progress-only.
  useEffect(() => {
    if (!engineReady || (linkedPrinters.length === 0 && bambuPrinters.length === 0)) {
      setHostStatusByIntegration({});
      return;
    }
    let cancelled = false;
    const integrationIds = [
      ...new Set(
        [...linkedPrinters, ...bambuPrinters]
          .map((p) => p.integration_id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const tick = async () => {
      if (cancelled || document.hidden) return;
      const entries = await Promise.all(
        integrationIds.map(async (id) => {
          try {
            return [id, await fetchIntegrationStatus(id)] as const;
          } catch (e) {
            return [
              id,
              {
                state: "offline" as const,
                message: e instanceof Error ? e.message : String(e),
              },
            ] as const;
          }
        }),
      );
      if (cancelled) return;
      setHostStatusByIntegration(Object.fromEntries(entries));
    };

    void tick();
    const timer = window.setInterval(() => void tick(), pollMs);
    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [engineReady, linkedPrinters, bambuPrinters, pollMs]);

  // Re-propose when remaining parts change after a successful local parse.
  useEffect(() => {
    if (!objectParse || objectParse.unlabeled) return;
    setObjectPropose(proposeCheckoffFromObjects(objectParse.names, remainingParts));
  }, [remainingParts, objectParse]);

  const selectedHostStatus = useMemo(() => {
    const machine = linkedPrinters.find((p) => p.id === selectedPrinterId);
    const integrationId = machine?.integration_id?.trim();
    if (!integrationId) return undefined;
    return hostStatusByIntegration[integrationId];
  }, [hostStatusByIntegration, linkedPrinters, selectedPrinterId]);

  const selectedPrinterBusy =
    selectedHostStatus?.state === "printing" || selectedHostStatus?.state === "paused";
  const selectedPrinterUnavailable =
    selectedHostStatus?.state === "offline" || selectedHostStatus?.state === "error";

  /** Proposed units from local object parse — never auto-ticks Progress. */
  const proposedUnits = useMemo(() => objectPropose?.units ?? [], [objectPropose]);

  const effectiveCheckoffUnits = useMemo(() => {
    if (profileId == null) return [];
    return proposedUnits;
  }, [profileId, proposedUnits]);

  const previewRows = useMemo(() => {
    if (!objectPropose) return [];
    return buildObjectPreviewRows(objectPropose, remainingParts);
  }, [objectPropose, remainingParts]);

  const hasNamedObjects =
    objectParse != null && !objectParse.unlabeled && objectParse.names.length > 0;

  const onPrinterChange = (id: string) => {
    setSelectedPrinterId(id);
    writeStickyId(PRINTER_ID_STORAGE_KEY, id);
  };

  const onBambuPrinterChange = (id: string) => {
    setSelectedBambuPrinterId(id);
    writeStickyId(BAMBU_PRINTER_ID_STORAGE_KEY, id);
  };

  /** `Shop Printer · Moonraker` when the integration type is known. */
  const printerLabel = (p: PrinterMachine): string => {
    const hostType = hostTypeByPrinterId[p.id];
    return hostType ? `${p.name} · ${printerHostTypeLabel(hostType)}` : p.name;
  };

  const runUpload = (file: File, start: boolean) => {
    const retry = () => runUpload(file, start);
    if (!planBind.canSend || profileId == null) {
      setSendFailure({ message: "Pick a Build before you send this file.", retry });
      return;
    }
    if (!selectedPrinterId) {
      setSendFailure({
        message: "No linked printer. Add a Moonraker or PrusaLink host in Settings, then link it to a machine.",
        retry,
      });
      return;
    }
    if (start && selectedPrinterBusy) {
      setSendFailure({
        message: "The printer is busy. Send still works. Start print is available when it is idle.",
        retry,
      });
      return;
    }
    if (start && selectedPrinterUnavailable) {
      setSendFailure({
        message: selectedHostStatus?.message?.trim() || "The printer host is offline or in error.",
        retry,
      });
      return;
    }
    setSendFailure(null);

    const units =
      effectiveCheckoffUnits.length > 0 ? effectiveCheckoffUnits : undefined;
    const unlabeled =
      objectPropose?.unmatchedNames?.length ? objectPropose.unmatchedNames : undefined;
    const printerName =
      linkedPrinters.find((p) => p.id === selectedPrinterId)?.name ?? "printer";

    void printerUploadJob.runJob(
      () =>
        startPrinterUpload({
          file,
          printer_id: selectedPrinterId,
          start,
          // GRE-232: always stamp active spine plan at send (immutable after).
          profile_id: profileId,
          checkoff_units: units,
          unlabeled_names: unlabeled,
        }),
      (snap) => {
        if (snap.status === "error") {
          setSendFailure({
            message: snap.message || `Could not send ${file.name} to ${printerName}.`,
            retry,
          });
          return;
        }
        setSendFailure(null);
        const mapped =
          typeof snap.result?.checkoff_units === "number"
            ? snap.result.checkoff_units
            : units?.length ?? 0;
        if (mapped > 0) {
          toast.success(snap.message || `Sent ${file.name} to ${printerName}`, {
            description: `Will queue ${mapped} Checkoff unit${mapped === 1 ? "" : "s"} for verification when the print finishes.`,
          });
        } else {
          toast.success(snap.message || `Sent ${file.name} to ${printerName}`);
        }
      },
      { profileId },
    );
  };

  const rejectFile = () => {
    setChosenFile(null);
    setObjectParse(null);
    setObjectPropose(null);
    setSendFailure(null);
  };

  const ensureFileThen = (action: "send" | "start") => {
    if (chosenFile) {
      runUpload(chosenFile, action === "start");
      return;
    }
    pendingActionRef.current = action;
    fileInputRef.current?.click();
  };

  const applyObjectParse = async (file: File): Promise<ProposeCheckoffResult | null> => {
    const gen = ++parseGenRef.current;
    setParseBusy(true);
    setObjectParse(null);
    setObjectPropose(null);
    try {
      const parsed = await parseSlicedObjectsFile(file);
      if (gen !== parseGenRef.current) return null;
      setObjectParse(parsed);
      const proposed = proposeCheckoffFromObjects(parsed.names, remainingParts);
      setObjectPropose(proposed);
      return proposed;
    } catch (e) {
      if (gen !== parseGenRef.current) return null;
      setObjectParse({ objects: [], names: [], format: "unknown", unlabeled: true });
      setObjectPropose({ units: [], matches: [], unmatchedNames: [] });
      toast.error("Could not parse object names", {
        description: e instanceof Error ? e.message : String(e),
      });
      return null;
    } finally {
      if (gen === parseGenRef.current) setParseBusy(false);
    }
  };

  const onFileChosen = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) {
      pendingActionRef.current = null;
      return;
    }
    if (!isAllowedGcode(file.name)) {
      setSendFailure({
        message: "Wrong file type. Choose a sliced .gcode, .gco, or .bgcode file.",
        retry: () => fileInputRef.current?.click(),
      });
      pendingActionRef.current = null;
      return;
    }
    setSendFailure(null);
    setChosenFile(file);
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    void (async () => {
      const proposed = await applyObjectParse(file);
      // Preview before Send when objects were matched — don't auto-upload past the preview.
      if (pending) {
        if (proposed && proposed.units.length > 0) {
          return;
        }
        // Unlabeled / empty propose may proceed without checkoff units.
        runUpload(file, pending === "start");
      }
    })();
  };

  const onBambuFileChosen = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (bambuFileInputRef.current) bambuFileInputRef.current.value = "";
    if (!file) return;
    if (!isAllowedBambuConnectFile(file.name)) {
      toast.error("Wrong file type", {
        description: "Choose a sliced .3mf or .gcode file for Bambu Connect.",
      });
      return;
    }
    if (!selectedBambuPrinterId) {
      toast.error("No linked Bambu printer", {
        description: "Add a Bambu host in Settings, then link it to a machine.",
      });
      return;
    }
    if (!planBind.canSend || profileId == null) {
      toast.error("Pick a plan to bind this send.");
      return;
    }
    setChosenFile(file);
    void (async () => {
      let handoffUnits: typeof proposedUnits | undefined;
      try {
        const parsed = await parseSlicedObjectsFile(file);
        setObjectParse(parsed);
        const proposed = proposeCheckoffFromObjects(parsed.names, remainingParts);
        setObjectPropose(proposed);
        if (proposed.units.length > 0) {
          handoffUnits = proposed.units;
        }
      } catch {
        setObjectParse({ objects: [], names: [], format: "unknown", unlabeled: true });
        setObjectPropose({ units: [], matches: [], unmatchedNames: [] });
      }

      setBambuBusy(true);
      try {
        const result = await startBambuConnectHandoff({
          file,
          printer_id: selectedBambuPrinterId,
          // GRE-232: stamp active spine plan at handoff.
          profile_id: profileId,
          checkoff_units: handoffUnits,
        });
        if (result.launched) {
          toast.success(result.message, {
            description: result.checkoff_link_id
              ? "Checkoff verification will wait for this print to finish on the linked Bambu."
              : "Confirm the import in Bambu Connect. Does not start a print from here.",
          });
        } else {
          toast.message(result.message, {
            description: "Copy the Connect URL or download the staged file.",
            action: {
              label: "Copy URL",
              onClick: () => {
                void navigator.clipboard.writeText(result.connect_url);
              },
            },
          });
          if (result.in_container && result.download_path) {
            window.open(bambuConnectDownloadUrl(result.download_path), "_blank");
          }
        }
        if (!result.launched && !result.in_container) {
          try {
            window.location.href = result.connect_url;
          } catch {
            /* custom scheme may be blocked in some browsers */
          }
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBambuBusy(false);
      }
    })();
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="border-border shadow-sm">
        <CardHeader className="space-y-1.5 pb-2">
          <CardTitle className="text-sm font-semibold leading-snug">
            Send to printer
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Export remaining STLs, slice in your slicer, choose the .gcode here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5 pt-1">
          {sendFailure ? (
            <div
              className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/35 bg-destructive-soft px-3 py-2"
              role="alert"
            >
              <p className="min-w-0 flex-1 text-sm text-destructive">{sendFailure.message}</p>
              <Button
                size="sm"
                variant="secondary"
                className="min-h-11"
                onClick={() => {
                  const retry = sendFailure.retry;
                  setSendFailure(null);
                  retry();
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept=".gcode,.bgcode,.gco,application/octet-stream"
            className="hidden"
            onChange={(e) => onFileChosen(e.target.files)}
          />

          {printersLoading && !hasLinked ? (
            <div
              className="flex flex-col gap-2"
              role="status"
              aria-label="Loading linked printers"
              data-testid="printer-send-panel-loading"
            >
              <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            </div>
          ) : hasLinked ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="min-h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                  value={selectedPrinterId}
                  disabled={busy}
                  aria-label="Target printer"
                  onChange={(e) => onPrinterChange(e.target.value)}
                >
                  {linkedPrinters.map((p) => (
                    <option key={p.id} value={p.id}>
                      {printerLabel(p)}
                    </option>
                  ))}
                </select>
                <Badge
                  variant={printerSendStatusVariant(selectedHostStatus)}
                  className="shrink-0 rounded-full px-2 py-0.5 font-mono text-2xs font-normal"
                >
                  {printerSendStatusLabel(selectedHostStatus)}
                </Badge>
              </div>

              {/* ── Approval gate: shown when a file is chosen and parsed ── */}
              {chosenFile && objectParse ? (
                <PlateApprovalCard
                  thumbnailUrl={objectParse.thumbnailUrl}
                  printerName={
                    linkedPrinters.find((p) => p.id === selectedPrinterId)?.name ?? "Printer"
                  }
                  plateIndex={1}
                  plateTotal={1}
                  printTime={objectParse.printTime}
                  filamentWeightG={objectParse.filamentWeightG}
                  unmatchedNames={objectPropose?.unmatchedNames ?? []}
                  busy={printerUploadJob.busy}
                  onApprove={() => {
                    if (chosenFile) runUpload(chosenFile, false);
                  }}
                  onReject={rejectFile}
                />
              ) : null}

              {/* Proposal rows shown below the approval card when there are named objects */}
              {chosenFile && objectParse && hasNamedObjects && !objectParse.thumbnailUrl ? (
                <ObjectProposalRows rows={previewRows} />
              ) : null}

              {/* File picker row — always shown so user can change the file */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {chosenFile ? chosenFile.name : "No file chosen"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 min-w-11"
                  disabled={busy || parseBusy}
                  loading={parseBusy}
                  onClick={() => {
                    pendingActionRef.current = null;
                    fileInputRef.current?.click();
                  }}
                >
                  {parseBusy ? "Parsing…" : chosenFile ? "Change" : "Choose .gcode"}
                </Button>
              </div>

              {/* Send / Start buttons — only shown when no file is chosen (before approval gate) */}
              {!chosenFile ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 min-w-11"
                    disabled={busy || !selectedPrinterId || !planBind.canSend}
                    title={!planBind.canSend ? planBind.line : undefined}
                    onClick={() => ensureFileThen("send")}
                  >
                    Send
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-11 min-w-11"
                    disabled={
                      busy ||
                      !selectedPrinterId ||
                      !planBind.canSend ||
                      selectedPrinterBusy ||
                      selectedPrinterUnavailable
                    }
                    title={
                      !planBind.canSend
                        ? planBind.line
                        : selectedPrinterBusy
                          ? "Printer is busy — Start print waits until Idle"
                          : selectedPrinterUnavailable
                            ? "Printer offline or error"
                            : undefined
                    }
                    onClick={() => ensureFileThen("start")}
                  >
                    Start print
                  </Button>
                </div>
              ) : null}

              <p className="text-2xs leading-relaxed text-muted-foreground">
                {planBind.line}
              </p>
              {planBind.canSend ? (
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Send from here to track these parts on Progress.
                </p>
              ) : null}
              {selectedPrinterBusy ? (
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Printer is busy. Send still works. Or wait until Idle.
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs leading-relaxed text-muted-foreground">
                No linked printers yet. Add a Klipper or Prusa printer in Settings to Send
                and Start print.
              </p>
              <Button size="sm" variant="outline" asChild className="w-fit">
                <Link to={settingsPrintersRoute()}>Add printers in Settings</Link>
              </Button>
              {!hasBambuLinked ? (
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Bambu Connect is available after you link a Bambu host. It never starts a
                  print from here.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {hasBambuLinked ? (
        <Card className="border-border shadow-sm">
          <CardHeader className="space-y-1.5 pb-2">
            <CardTitle className="text-sm font-semibold leading-snug">
              Bambu Connect
            </CardTitle>
            <CardDescription className="text-xs leading-relaxed">
              Does not start a print from here.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 pt-1">
            <input
              ref={bambuFileInputRef}
              type="file"
              accept=".3mf,.gcode,.gco,application/octet-stream"
              className="hidden"
              onChange={(e) => onBambuFileChosen(e.target.files)}
            />
            <select
              className="min-h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={selectedBambuPrinterId}
              disabled={busy}
              aria-label="Bambu printer for Connect handoff"
              onChange={(e) => onBambuPrinterChange(e.target.value)}
            >
              {bambuPrinters.map((p) => {
                const integrationId = p.integration_id?.trim() ?? "";
                const label = printerSendStatusLabel(hostStatusByIntegration[integrationId]);
                return (
                  <option key={p.id} value={p.id}>
                    {printerLabel(p)} · {label}
                  </option>
                );
              })}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !selectedBambuPrinterId || !planBind.canSend}
              title={
                !planBind.canSend
                  ? planBind.line
                  : "Stages the file and opens bambu-connect:// when possible"
              }
              onClick={() => bambuFileInputRef.current?.click()}
            >
              {bambuBusy ? "Handing off…" : "Open in Bambu Connect"}
            </Button>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {planBind.line}
            </p>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Opens Bambu Connect with the sliced file. Does not start a print from here.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

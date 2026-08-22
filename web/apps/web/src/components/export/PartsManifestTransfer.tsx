import { useId, useRef, useState } from "react";
import { FileSpreadsheet, HardDrive, Upload } from "lucide-react";
import { toast } from "sonner";
import type { SourceSummary } from "@print-partner/contracts";
import { importAcceptedPrintedCounts, type PlanReview } from "../../api/engine";
import { useEngineHealth } from "../../hooks/useEngineHealth";
import { usePlanWorkspace } from "../../context/PlanWorkspaceContext";
import {
  applyPartsManifest,
  buildPartsManifestRows,
  manifestDownloadBasename,
  parseManifestCsv,
  rowsToCsv,
  triggerBrowserDownload,
  type ManifestParseIssue,
  type PartsManifestRow,
} from "../../lib/partsManifest";
import { parsePartsManifestXlsx, partsManifestToXlsxBlob } from "../../lib/partsManifestXlsx";
import {
  downloadGoogleDriveFile,
  listGoogleDriveManifestFiles,
  requestGoogleDriveToken,
  resolveGoogleClientId,
  uploadBlobToGoogleDrive,
  type DriveFileRef,
} from "../../lib/googleDrive";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type Props = {
  review: PlanReview | null;
  sources: SourceSummary[];
  onApplied?: () => void | Promise<void>;
};

async function rowsFromFile(file: File): Promise<{
  rows: PartsManifestRow[];
  errors: ManifestParseIssue[];
}> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parsePartsManifestXlsx(await file.arrayBuffer());
  }
  const text = await file.text();
  return parseManifestCsv(text);
}

export default function PartsManifestTransfer({ review, sources, onApplied }: Props) {
  const { health } = useEngineHealth();
  const { draftWorkspace, editActivePlanDraft } = usePlanWorkspace();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();
  const [busy, setBusy] = useState(false);
  const [applyIncluded, setApplyIncluded] = useState(false);
  const [applyPrinted, setApplyPrinted] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveFiles, setDriveFiles] = useState<DriveFileRef[]>([]);
  const [lastErrors, setLastErrors] = useState<ManifestParseIssue[]>([]);

  const googleClientId = resolveGoogleClientId(health?.google_drive?.client_id);
  const driveReady = Boolean(googleClientId);
  const canExport = Boolean(review);

  const buildRows = (): PartsManifestRow[] => {
    if (!review) return [];
    return buildPartsManifestRows({ review, sources });
  };

  const exportCsv = () => {
    if (!review) return;
    const rows = buildRows();
    const blob = new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
    triggerBrowserDownload(blob, manifestDownloadBasename(review.plan_name, "csv"));
    toast.success(`Exported ${rows.length} part row(s) as CSV`);
  };

  const exportXlsx = async () => {
    if (!review) return;
    setBusy(true);
    try {
      const rows = buildRows();
      const blob = await partsManifestToXlsxBlob(rows);
      triggerBrowserDownload(blob, manifestDownloadBasename(review.plan_name, "xlsx"));
      toast.success(`Exported ${rows.length} part row(s) as Excel`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveToDrive = async (kind: "csv" | "xlsx") => {
    if (!review || !googleClientId) return;
    setBusy(true);
    try {
      const rows = buildRows();
      const token = await requestGoogleDriveToken(googleClientId);
      const filename = manifestDownloadBasename(review.plan_name, kind);
      const blob =
        kind === "csv"
          ? new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8" })
          : await partsManifestToXlsxBlob(rows);
      const mime =
        kind === "csv"
          ? "text/csv"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const file = await uploadBlobToGoogleDrive(token, blob, filename, mime);
      toast.success(`Saved to Google Drive: ${file.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (rows: PartsManifestRow[], parseErrors: ManifestParseIssue[]) => {
    if (!review) {
      toast.error("Select a plan before importing");
      return;
    }
    if (parseErrors.length) {
      setLastErrors(parseErrors);
      toast.error(parseErrors[0]!.message);
      return;
    }
    if (!rows.length) {
      toast.error("No data rows found");
      return;
    }
    setBusy(true);
    try {
      const result = await applyPartsManifest(rows, review, {
        applyQuantity: true,
        applyIncluded,
        applyPrintedProgress: applyPrinted,
        draftWorkspace,
        applyDraftDecisions: editActivePlanDraft,
        applyAcceptedProgress: async (expected, progressRows) => {
          await importAcceptedPrintedCounts({
            profileId: review.profile_id,
            expected,
            rows: progressRows,
          });
        },
      });
      setLastErrors(result.errors);
      if (result.updated > 0) {
        toast.success(`Updated ${result.updated} part(s)`);
        await onApplied?.();
      } else if (result.errors.length === 0) {
        toast.message("No changes needed");
      }
      if (result.errors.length) {
        toast.error(`${result.errors.length} row error(s) — see details below`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFilePicked = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const parsed = await rowsFromFile(file);
      await runImport(parsed.rows, parsed.errors);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDrivePicker = async () => {
    if (!googleClientId) return;
    setBusy(true);
    try {
      const token = await requestGoogleDriveToken(googleClientId);
      const files = await listGoogleDriveManifestFiles(token);
      setDriveFiles(files);
      setDriveOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importDriveFile = async (file: DriveFileRef) => {
    if (!googleClientId) return;
    setBusy(true);
    try {
      const token = await requestGoogleDriveToken(googleClientId);
      const downloaded = await downloadGoogleDriveFile(token, file);
      const parsed =
        downloaded.kind === "csv"
          ? parseManifestCsv(new TextDecoder().decode(downloaded.bytes))
          : await parsePartsManifestXlsx(downloaded.bytes);
      setDriveOpen(false);
      await runImport(parsed.rows, parsed.errors);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle level={3} className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            Parts manifest (CSV / Excel / Drive)
          </CardTitle>
          <CardDescription>
            Export or import quantity (and optional progress) using a stable parts
            spreadsheet. Columns: source link, file name, quantity, plus filament,
            path, progress, and match keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!canExport || busy} onClick={exportCsv}>
              Download CSV
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canExport || busy}
              onClick={() => void exportXlsx()}
            >
              Download Excel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canExport || !driveReady || busy}
              onClick={() => void saveToDrive("csv")}
              title={driveReady ? "Upload CSV to Google Drive" : "Set GOOGLE_CLIENT_ID"}
            >
              <HardDrive className="mr-1 h-3.5 w-3.5" />
              Save CSV to Drive
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canExport || !driveReady || busy}
              onClick={() => void saveToDrive("xlsx")}
              title={driveReady ? "Upload Excel to Google Drive" : "Set GOOGLE_CLIENT_ID"}
            >
              <HardDrive className="mr-1 h-3.5 w-3.5" />
              Save Excel to Drive
            </Button>
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium">Import</p>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={applyIncluded}
                  onChange={(e) => setApplyIncluded(e.target.checked)}
                />
                Propose included flag
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={applyPrinted}
                  onChange={(e) => setApplyPrinted(e.target.checked)}
                />
                Apply printed counts to accepted Checkoff (run separately)
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                id={fileInputId}
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  void onFilePicked(f);
                }}
              />
              <Button
                type="button"
                size="sm"
                disabled={!canExport || busy}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="mr-1 h-3.5 w-3.5" />
                Import file
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!canExport || !driveReady || busy}
                onClick={() => void openDrivePicker()}
              >
                <HardDrive className="mr-1 h-3.5 w-3.5" />
                Open from Drive
              </Button>
            </div>
            {!driveReady && (
              <p className="text-xs text-muted-foreground">
                Google Drive needs <code className="font-mono">GOOGLE_CLIENT_ID</code>{" "}
                (OAuth Web client; public id only) on the API, or{" "}
                <code className="font-mono">VITE_GOOGLE_CLIENT_ID</code> at build time.
              </p>
            )}
            {!canExport && (
              <p className="text-xs text-muted-foreground">Select a plan to export or import.</p>
            )}
          </div>

          {lastErrors.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
              {lastErrors.slice(0, 20).map((err) => (
                <div key={`${err.row}-${err.message}`}>
                  Row {err.row}: {err.message}
                </div>
              ))}
              {lastErrors.length > 20 && <div>…and {lastErrors.length - 20} more</div>}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={driveOpen} onOpenChange={setDriveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open from Google Drive</DialogTitle>
          </DialogHeader>
          {driveFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recent CSV/Excel manifests found for this Google account (Drive only lists
              files this app created or opened with drive.file scope).
            </p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
              {driveFiles.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                    disabled={busy}
                    onClick={() => void importDriveFile(f)}
                  >
                    <span className="font-medium">{f.name}</span>
                    {f.modifiedTime && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {new Date(f.modifiedTime).toLocaleString()}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

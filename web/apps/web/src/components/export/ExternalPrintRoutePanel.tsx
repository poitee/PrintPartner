import { useCallback, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Upload } from "lucide-react";
import type { PrinterCheckoffUnit } from "@print-partner/contracts";
import {
  assignUploadedPrinterFile,
  uploadPrintFileForAssignment,
  type UploadedPrintFileCheck,
} from "../../api/endpoints/checkoff";
import { fetchIntegrations, type IntegrationSummary } from "../../api/endpoints/integrations";
import {
  fetchPrinterCapabilities,
  fetchPrinters,
  type PrinterCapabilities,
  type PrinterMachine,
} from "../../api/endpoints/printers";
import { useProfileSelection } from "../../context/ProfileContext";
import { parseSlicedObjectsFile } from "../../lib/parseSlicedObjects";
import { settingsPrintersRoute } from "../../lib/routes";
import { Button } from "../ui/button";
import { StatusBadge } from "../ui/status-badge";
import InlineOperationError from "../printers/InlineOperationError";
import PrinterFilesView from "../printers/PrinterFilesView";
import { failureMessage, useAsyncView } from "../printers/asyncView";
import { printFileCheckSummary } from "../printers/printFileClassification";
import { requiredUnitToken } from "../printers/printFileAssignment";

type Props = Readonly<{
  profileId: number;
  /** Called once a print is on the record, so the work package can move on. */
  onRecorded: () => void;
}>;

/** Where the bytes of an already finished print are. */
type FileSource = "printer" | "computer";

/** One printer, with the linked host that can answer for it. */
type PrinterDesk = Readonly<{
  printer: PrinterMachine;
  /** Null when no enabled host is linked, so nothing can browse its storage. */
  host: IntegrationSummary | null;
}>;

/** What went on the record, for the line the operator reads afterwards. */
type RecordedPrint = Readonly<{ filename: string; unitCount: number }>;

// The same four containers the printer workspace accepts. The server checks the
// bytes; this only keeps an obviously wrong pick out of a 64 MiB upload.
const PRINT_FILE_PATTERN = /\.(?:gcode|gco|bgcode|3mf)$/i;

/**
 * Record a print that already happened, from inside the work package.
 *
 * Nothing here starts a print. The two sources are a file still sitting on a
 * printer PrintPartner watches, and a file on this computer, which is the only
 * way a printer PrintPartner cannot talk to reaches Checkoff at all. Both end at
 * the same question: which Required units did this print cover.
 *
 * The printer-storage source is `PrinterFilesView` unchanged, so the browsing,
 * the classification and the assignment stay in one place rather than being
 * forked for Production.
 */
export default function ExternalPrintRoutePanel({ profileId, onRecorded }: Props) {
  const fieldPrefix = useId();
  const { profiles } = useProfileSelection();
  const [source, setSource] = useState<FileSource | null>(null);
  const [printerId, setPrinterId] = useState("");
  const [recorded, setRecorded] = useState<RecordedPrint | null>(null);

  const fleetRequest = useCallback(async (): Promise<PrinterDesk[]> => {
    const [fleet, integrations] = await Promise.all([fetchPrinters(), fetchIntegrations()]);
    const byId = new Map(integrations.map((integration) => [integration.id, integration]));
    return fleet
      .filter((printer) => printer.enabled !== false)
      .map((printer) => {
        const linkedId = printer.integration_id?.trim();
        const candidate = linkedId ? byId.get(linkedId) : undefined;
        return {
          printer,
          host: candidate && candidate.config.enabled !== false ? candidate : null,
        };
      });
  }, []);
  const fleet = useAsyncView({
    request: fleetRequest,
    fallbackMessage: "The server did not answer the printer request.",
  });

  // Only asked for once the operator is actually browsing a printer, because the
  // answer decides whether that printer has storage to browse at all.
  const capabilityRequest = useCallback(
    async (): Promise<PrinterCapabilities | null> =>
      source === "printer" && printerId ? fetchPrinterCapabilities(printerId) : null,
    [source, printerId],
  );
  const capabilities = useAsyncView({
    request: capabilityRequest,
    fallbackMessage: "The server did not answer the capability request.",
  });

  const desks = fleet.view.status === "ready" ? fleet.view.data : [];
  const watched = desks.filter((desk) => desk.host !== null);
  const chosen = desks.find((desk) => desk.printer.id === printerId) ?? null;
  const builds = profiles.filter((profile) => profile.id === profileId);

  const finish = (print: RecordedPrint) => {
    setRecorded(print);
    onRecorded();
  };

  if (recorded) {
    return (
      <section aria-label="Record a print made elsewhere" className="stack-section">
        <StatusBadge
          status="complete"
          label={`${recorded.filename} is on the record, covering ${recorded.unitCount} Required unit${recorded.unitCount === 1 ? "" : "s"}`}
          live
        />
        <p className="text-body">
          Checkoff now holds this print. Verify the units there when you have checked the parts.
        </p>
        <Button
          size="shop"
          variant="outline"
          className="self-start"
          onClick={() => {
            setRecorded(null);
            setSource(null);
            setPrinterId("");
          }}
        >
          Record another print
        </Button>
      </section>
    );
  }

  return (
    <section aria-label="Record a print made elsewhere" className="stack-section">
      <p className="text-body">
        This records a print that already happened. Nothing here sends anything to a printer.
      </p>

      <fieldset className="stack-row">
        <legend className="text-body font-medium">Where is the print file?</legend>
        <label className="flex min-h-11 items-start gap-2 py-1 text-body">
          <input
            type="radio"
            className="mt-1.5 h-4 w-4"
            name={`${fieldPrefix}-source`}
            checked={source === "printer"}
            onChange={() => setSource("printer")}
          />
          <span>
            <span className="block font-medium">On a printer PrintPartner watches</span>
            <span className="block text-meta text-muted-foreground">
              Browse that printer's own storage and pick the file it ran.
            </span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2 py-1 text-body">
          <input
            type="radio"
            className="mt-1.5 h-4 w-4"
            name={`${fieldPrefix}-source`}
            checked={source === "computer"}
            onChange={() => setSource("computer")}
          />
          <span>
            <span className="block font-medium">On this computer</span>
            <span className="block text-meta text-muted-foreground">
              Upload G-code, binary G-code, or a 3MF. This is the way in for a printer
              PrintPartner cannot talk to.
            </span>
          </span>
        </label>
      </fieldset>

      {fleet.view.status === "loading" ? (
        <p className="text-body text-muted-foreground" role="status">
          Loading your printers…
        </p>
      ) : null}

      {fleet.view.status === "failed" ? (
        <InlineOperationError
          title="Could not load your printers"
          message={fleet.view.message}
          onRetry={fleet.reload}
          retryLabel="Try again"
        />
      ) : null}

      {source !== null && fleet.view.status === "ready" && desks.length === 0 ? (
        <p className="rounded-md border border-dashed border-border-strong p-4 text-body text-muted-foreground">
          PrintPartner has no printers yet. A print is recorded against the printer that made it,
          so add that printer first.{" "}
          <Link className="underline" to={settingsPrintersRoute()}>
            Open printer settings
          </Link>
        </p>
      ) : null}

      {source === "printer" && desks.length > 0 ? (
        <div className="stack-section">
          {watched.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-strong p-4 text-body text-muted-foreground">
              None of your printers has a linked host, so there is no storage to browse. Choose On
              this computer and upload the file instead.
            </p>
          ) : (
            <div className="stack-row">
              <label className="text-body font-medium" htmlFor={`${fieldPrefix}-printer`}>
                Which printer made this print?
              </label>
              <select
                id={`${fieldPrefix}-printer`}
                className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-body"
                value={printerId}
                onChange={(event) => setPrinterId(event.target.value)}
              >
                <option value="">Choose a printer…</option>
                {watched.map((desk) => (
                  <option key={desk.printer.id} value={desk.printer.id}>
                    {desk.printer.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {chosen && capabilities.view.status === "loading" ? (
            <p className="text-body text-muted-foreground" role="status">
              Checking what {chosen.printer.name} can do…
            </p>
          ) : null}

          {chosen && capabilities.view.status === "failed" ? (
            <InlineOperationError
              title={`Could not check what ${chosen.printer.name} can do`}
              message={capabilities.view.message}
              onRetry={capabilities.reload}
              retryLabel="Try again"
            />
          ) : null}

          {chosen && capabilities.view.status === "ready" && capabilities.view.data ? (
            capabilities.view.data.files ? (
              <>
                <p className="text-meta text-muted-foreground">
                  The print already happened, so mark it finished when you assign it. That is what
                  puts it in front of you in Checkoff.
                </p>
                <PrinterFilesView
                  key={chosen.printer.id}
                  printer={chosen.printer}
                  host={chosen.host}
                  canBrowse
                  profiles={builds}
                  selectedProfileId={profileId}
                  onAssigned={(link) =>
                    finish({ filename: link.filename, unitCount: link.units.length })
                  }
                />
              </>
            ) : (
              <p className="rounded-md border border-dashed border-border-strong p-4 text-body text-muted-foreground">
                {chosen.printer.name} does not serve its stored files to PrintPartner. Choose On
                this computer and upload the file instead.
              </p>
            )
          ) : null}
        </div>
      ) : null}

      {source === "computer" && desks.length > 0 ? (
        <UploadedPrintRecord
          profileId={profileId}
          printers={desks.map((desk) => desk.printer)}
          onRecorded={finish}
        />
      ) : null}
    </section>
  );
}

/** The file the operator picked, with the object labels this browser read from it. */
type ReadPrintFile = Readonly<{ file: File; objectNames: string[] }>;

/**
 * Uploading a print file, then putting it on the record.
 *
 * One union rather than a bag of flags, so the states this route does not have,
 * such as uploading a file whose bytes were never read, cannot be built. The
 * chosen file is carried by every phase after it is read, which is what lets a
 * failed upload or a failed save rerun without asking for the file again.
 */
type UploadState =
  | { phase: "choosing" }
  | { phase: "reading"; filename: string }
  | { phase: "read_failed"; filename: string; message: string }
  | { phase: "uploading"; chosen: ReadPrintFile }
  | { phase: "upload_failed"; chosen: ReadPrintFile; message: string }
  | { phase: "confirming"; chosen: ReadPrintFile; check: UploadedPrintFileCheck }
  | { phase: "saving"; chosen: ReadPrintFile; check: UploadedPrintFileCheck }
  | {
      phase: "save_failed";
      chosen: ReadPrintFile;
      check: UploadedPrintFileCheck;
      message: string;
    };

/** One problem with the record form, named by the field it belongs to. */
type RecordFieldError = Readonly<{ field: "printer" | "units"; message: string }>;

function recordProblems(input: {
  printerId: string;
  confirmedUnitCount: number;
}): RecordFieldError[] {
  const problems: RecordFieldError[] = [];
  if (!input.printerId) {
    problems.push({ field: "printer", message: "Choose the printer that made this print" });
  }
  if (input.confirmedUnitCount === 0) {
    problems.push({
      field: "units",
      message: "Confirm at least one Required unit this print covers",
    });
  }
  return problems;
}

/**
 * What the suggestion was drawn from, in the operator's language.
 *
 * The same three cases the printer path reads, worded for a file PrintPartner
 * has only just met: it has no history with this printer and no folder to judge
 * it by, so a filename match deserves a harder look.
 */
function suggestionCaption(basis: UploadedPrintFileCheck["suggestion_basis"]): string {
  switch (basis) {
    case "object_names":
      return "Matched from the object labels inside the file. Clear anything this print did not cover.";
    case "filename":
      return "Matched from the file name, because the file carries no object labels. Check every unit before you record it.";
    case "none":
      return "Nothing in this file matched a Required unit. Pick the units this print covered by hand.";
    default: {
      const _exhaustive: never = basis;
      return _exhaustive;
    }
  }
}

function UploadedPrintRecord({
  profileId,
  printers,
  onRecorded,
}: {
  profileId: number;
  printers: readonly PrinterMachine[];
  onRecorded: (print: RecordedPrint) => void;
}) {
  const fieldPrefix = useId();
  const printerErrorId = `${fieldPrefix}-printer-error`;
  const unitsErrorId = `${fieldPrefix}-units-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [printerId, setPrinterId] = useState("");
  const [confirmedTokens, setConfirmedTokens] = useState<ReadonlySet<string>>(new Set());
  const [showProblems, setShowProblems] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>({ phase: "choosing" });

  const problems = recordProblems({ printerId, confirmedUnitCount: confirmedTokens.size });
  const visibleProblems = showProblems ? problems : [];
  const printerProblem = visibleProblems.find((problem) => problem.field === "printer") ?? null;
  const unitsProblem = visibleProblems.find((problem) => problem.field === "units") ?? null;

  const upload = async (chosen: ReadPrintFile) => {
    setState({ phase: "uploading", chosen });
    try {
      const check = await uploadPrintFileForAssignment({
        profile_id: profileId,
        file: chosen.file,
        object_names: chosen.objectNames,
      });
      setConfirmedTokens(new Set(check.suggested_units.map(requiredUnitToken)));
      setShowProblems(false);
      setState({ phase: "confirming", chosen, check });
    } catch (error) {
      setState({
        phase: "upload_failed",
        chosen,
        message: failureMessage(error, "The server did not accept the upload."),
      });
    }
  };

  const offer = async (file: File) => {
    setRejected(null);
    setState({ phase: "reading", filename: file.name });
    try {
      const parsed = await parseSlicedObjectsFile(file);
      await upload({ file, objectNames: parsed.names });
    } catch (error) {
      setState({
        phase: "read_failed",
        filename: file.name,
        message: failureMessage(error, "The file could not be read."),
      });
    }
  };

  const record = async (chosen: ReadPrintFile, check: UploadedPrintFileCheck) => {
    setShowProblems(true);
    if (problems.length > 0) return;
    setState({ phase: "saving", chosen, check });
    try {
      const result = await assignUploadedPrinterFile({
        profile_id: profileId,
        printer_id: printerId,
        filename: chosen.file.name,
        upload_token: check.upload_token,
        object_names: chosen.objectNames,
        // The print is finished and PrintPartner never watched it, so there is
        // no host to wait for and nothing to mark complete later.
        tracking: "manual",
        completed: true,
        plan_revision_id: check.plan_revision_id,
        unit_tokens: [...confirmedTokens],
      });
      onRecorded({
        filename: result.link.filename,
        unitCount: result.link.units.length,
      });
    } catch (error) {
      setState({
        phase: "save_failed",
        chosen,
        check,
        message: failureMessage(error, "The server did not accept the record."),
      });
    }
  };

  const answered =
    state.phase === "confirming" || state.phase === "saving" || state.phase === "save_failed"
      ? {
          chosen: state.chosen,
          check: state.check,
          summary: printFileCheckSummary({
            preview: state.check,
            filename: state.chosen.file.name,
          }),
        }
      : null;
  const busy = state.phase === "reading" || state.phase === "uploading" || state.phase === "saving";

  return (
    <div className="stack-section">
      <div className="stack-row">
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          aria-label="Print file to upload"
          accept=".gcode,.gco,.bgcode,.3mf,application/octet-stream"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            if (PRINT_FILE_PATTERN.test(file.name)) void offer(file);
            else setRejected(file.name);
          }}
        />
        <Button
          size="shop"
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1.5 h-4 w-4" aria-hidden />
          {answered ? "Choose a different file" : "Choose the print file"}
        </Button>
        <p className="text-meta text-muted-foreground">
          PrintPartner reads the file you upload and says what it is. A 3MF that still needs slicing
          cannot be recorded as a print, whatever it is called.
        </p>
      </div>

      {rejected ? (
        <InlineOperationError
          title={`${rejected} is not a print file`}
          message="Choose a .gcode, .gco, .bgcode, or .3mf file."
          onRetry={() => inputRef.current?.click()}
          retryLabel="Choose another file"
        />
      ) : null}

      {state.phase === "reading" ? (
        <p className="text-body text-muted-foreground" role="status">
          Reading {state.filename}…
        </p>
      ) : null}

      {state.phase === "uploading" ? (
        <p className="text-body text-muted-foreground" role="status">
          Sending {state.chosen.file.name} to PrintPartner…
        </p>
      ) : null}

      {state.phase === "read_failed" ? (
        <InlineOperationError
          title={`Could not read ${state.filename}`}
          message={state.message}
          onRetry={() => inputRef.current?.click()}
          retryLabel="Choose another file"
        />
      ) : null}

      {state.phase === "upload_failed" ? (
        <InlineOperationError
          title={`Could not upload ${state.chosen.file.name}`}
          message={state.message}
          onRetry={() => void upload(state.chosen)}
          retryLabel="Upload again"
        />
      ) : null}

      {answered ? (
        <>
          <div className="stack-row rounded-md border border-border bg-background p-3">
            <p className="truncate font-mono text-body font-semibold" title={answered.chosen.file.name}>
              {answered.chosen.file.name}
            </p>
            <StatusBadge status={answered.summary.status} label={answered.summary.headline} live />
            <p className="text-body">{answered.summary.nextStep}</p>
          </div>

          {answered.summary.assignable ? (
            <>
              {visibleProblems.length > 0 ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-destructive"
                >
                  <p className="text-body font-semibold">
                    {visibleProblems.length === 1
                      ? "1 decision still needs your answer"
                      : `${visibleProblems.length} decisions still need your answer`}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-meta">
                    {visibleProblems.map((problem) => (
                      <li key={problem.field}>{problem.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="stack-row">
                <label className="text-body font-medium" htmlFor={`${fieldPrefix}-printer`}>
                  Which printer made this print?
                </label>
                <select
                  id={`${fieldPrefix}-printer`}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-body"
                  value={printerId}
                  aria-invalid={printerProblem ? true : undefined}
                  aria-describedby={printerProblem ? printerErrorId : undefined}
                  onChange={(event) => setPrinterId(event.target.value)}
                >
                  <option value="">Choose a printer…</option>
                  {printers.map((printer) => (
                    <option key={printer.id} value={printer.id}>
                      {printer.name}
                    </option>
                  ))}
                </select>
                {printerProblem ? (
                  <p id={printerErrorId} className="text-meta text-destructive">
                    {printerProblem.message}
                  </p>
                ) : null}
              </div>

              <UnitConfirmation
                units={answered.check.suggested_units}
                caption={suggestionCaption(answered.check.suggestion_basis)}
                unlabeledNames={answered.check.unlabeled_names}
                confirmedTokens={confirmedTokens}
                onToggle={(token, confirmed) =>
                  setConfirmedTokens((current) => {
                    const next = new Set(current);
                    if (confirmed) next.add(token);
                    else next.delete(token);
                    return next;
                  })
                }
                errorId={unitsErrorId}
                error={unitsProblem}
              />

              {state.phase === "save_failed" ? (
                <InlineOperationError
                  title={`Could not record ${state.chosen.file.name}`}
                  message={state.message}
                  onRetry={() => void record(state.chosen, state.check)}
                  retryLabel="Record again"
                />
              ) : null}

              <Button
                size="shop"
                className="self-start"
                loading={state.phase === "saving"}
                onClick={() => void record(answered.chosen, answered.check)}
              >
                Record this print
              </Button>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The Required units the operator has to agree with before anything is written. */
function UnitConfirmation({
  units,
  caption,
  unlabeledNames,
  confirmedTokens,
  onToggle,
  errorId,
  error,
}: {
  units: readonly PrinterCheckoffUnit[];
  caption: string;
  unlabeledNames: readonly string[];
  confirmedTokens: ReadonlySet<string>;
  onToggle: (token: string, confirmed: boolean) => void;
  errorId: string;
  error: RecordFieldError | null;
}) {
  return (
    <fieldset
      className="stack-row"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-body font-medium">Which Required units did this print cover?</legend>
      <p className="text-meta text-muted-foreground">{caption}</p>

      {units.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-background p-2">
          {units.map((unit) => {
            const token = requiredUnitToken(unit);
            return (
              <li key={token}>
                <label className="flex min-h-11 items-center gap-2 py-1 text-body">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0"
                    checked={confirmedTokens.has(token)}
                    onChange={(event) => onToggle(token, event.target.checked)}
                  />
                  <span className="truncate font-mono text-meta">
                    {unit.object_name ?? `Required unit ${unit.part_id}-${unit.unit_index + 1}`}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      {error ? (
        <p id={errorId} className="text-meta text-destructive">
          {error.message}
        </p>
      ) : null}

      {unlabeledNames.length > 0 ? (
        <div className="rounded-md border border-warning/35 bg-warning-soft p-2.5">
          <p className="text-meta font-medium text-warning">
            {unlabeledNames.length} object name{unlabeledNames.length === 1 ? "" : "s"} matched no
            Required unit
          </p>
          <ul className="mt-1 font-mono text-micro text-warning">
            {unlabeledNames.map((name) => (
              <li key={name} className="truncate">
                {name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}

import { useCallback, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Upload } from "lucide-react";
import {
  isUnmanagedPrinterId,
  UNMANAGED_PRINTER_ID,
  UNMANAGED_PRINTER_NAME,
  type PrinterCheckoffUnit,
  type PrintVerifyDecision,
} from "@print-partner/contracts";
import {
  assignUploadedPrinterFile,
  uploadPrintFileForAssignment,
  verifyPrinterCheckoff,
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
import { checkoffRoute, settingsPrintersRoute } from "../../lib/routes";
import { statusTone } from "../../lib/statusTone";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { StatusBadge } from "../ui/status-badge";
import InlineOperationError from "../printers/InlineOperationError";
import PrinterFilesView from "../printers/PrinterFilesView";
import { failureMessage, useAsyncView } from "../printers/asyncView";
import { printFileCheckSummary } from "../printers/printFileClassification";
import { requiredUnitToken } from "../printers/printFileAssignment";

type Props = Readonly<{
  profileId: number;
  /** Called once a print is on the record, so Checkoff can refresh its activity. */
  onRecorded: () => void;
  onProgressChanged: () => void;
}>;

/** Where the bytes of an already finished print are. */
type FileSource = "printer" | "computer";

/** One printer, with the linked host that can answer for it. */
type PrinterDesk = Readonly<{
  printer: PrinterMachine;
  /** Null when no enabled host is linked, so nothing can browse its storage. */
  host: IntegrationSummary | null;
}>;

/**
 * What went on the record, for the line the operator reads afterwards.
 *
 * `units` is the difference between the two answers to "have you checked the
 * parts": either the confirmed units are checked off already, or they are
 * waiting in Checkoff for someone to look at them. The wording afterwards must
 * never claim the first when only the second is true.
 */
type RecordedPrint = Readonly<{
  filename: string;
  unitCount: number;
  units: "checked_off" | "awaiting_check";
}>;

// The same four containers the printer workspace accepts. The server checks the
// bytes; this only keeps an obviously wrong pick out of a 64 MiB upload.
const PRINT_FILE_PATTERN = /\.(?:gcode|gco|bgcode|3mf)$/i;

/** "1 Required unit" or "3 Required units", in the Plan's own words. */
function requiredUnitCount(count: number): string {
  return `${count} Required unit${count === 1 ? "" : "s"}`;
}

/**
 * What is true now, for the operator reading the outcome.
 *
 * The two answers to "have you checked the parts" end in genuinely different
 * places, so they get genuinely different lines. Nothing here calls a unit
 * checked off unless the verify that checks it off has already succeeded.
 */
function recordedOutcome(print: RecordedPrint): Readonly<{
  headline: string;
  body: string;
  linkLabel: string;
}> {
  const units = requiredUnitCount(print.unitCount);
  switch (print.units) {
    case "checked_off":
      return {
        headline: `${print.filename} is on the record and ${units} ${
          print.unitCount === 1 ? "is" : "are"
        } checked off`,
        body: "Nothing is waiting on you for this print.",
        linkLabel: "See the units in Checkoff",
      };
    case "awaiting_check":
      return {
        headline: `${print.filename} is on the record, covering ${units}`,
        body: "The units are not checked off yet. Look at the parts, then check them off in Checkoff.",
        linkLabel: "Finish the units in Checkoff",
      };
    default: {
      const _exhaustive: never = print.units;
      return _exhaustive;
    }
  }
}

/**
 * Record a print that already happened, from the Checkoff printer desk.
 *
 * Nothing here starts a print. The two sources are a file still sitting on a
 * printer PrintPartner watches, and a file on this computer, which is the only
 * way a printer PrintPartner cannot talk to reaches Checkoff at all. Both end at
 * the same question: which Required units did this print cover.
 *
 * The upload source needs no registered printer. The reason a file is uploaded
 * rather than picked off a host is that PrintPartner cannot reach the machine
 * that ran it, so that machine may not be in the fleet at all, and an empty
 * fleet is a normal starting point here rather than a dead end.
 *
 * The printer-storage source is `PrinterFilesView` unchanged, so the browsing,
 * the classification and the assignment stay in one place rather than being
 * forked for Checkoff.
 */
export default function PastPrintIntakePanel({
  profileId,
  onProgressChanged,
  onRecorded,
}: Props) {
  const fieldPrefix = useId();
  const { profiles } = useProfileSelection();
  const [source, setSource] = useState<FileSource | null>(null);
  const [printerId, setPrinterId] = useState("");
  const [recorded, setRecorded] = useState<RecordedPrint[]>([]);

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
    setRecorded((current) => [...current, print]);
    onRecorded();
  };

  return (
    <section aria-label="Add a past print" className="stack-section">
      {recorded.length > 0 ? (
        <section className="stack-row" aria-labelledby={`${fieldPrefix}-recorded-heading`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${fieldPrefix}-recorded-heading`} className="text-body font-medium">
              Prints added this session ({recorded.length})
            </h3>
            <Link className="text-body underline underline-offset-2" to={checkoffRoute(profileId)}>
              Review parts in Checkoff
            </Link>
          </div>
          <ul className="space-y-2">
            {recorded.map((print, index) => {
              const outcome = recordedOutcome(print);
              return (
                <li
                  key={`${print.filename}:${index}`}
                  className="rounded-md border border-border bg-surface-sunken p-3"
                >
                  <StatusBadge status="complete" label={outcome.headline} live />
                  <p className="mt-1 text-meta text-muted-foreground">{outcome.body}</p>
                  <Link
                    className="mt-1 inline-block text-meta underline underline-offset-2"
                    to={checkoffRoute(profileId)}
                  >
                    {outcome.linkLabel}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <p className="text-body">
        Add each print you sliced or sent outside PrintPartner. Nothing here sends anything to a
        printer. Each file can use a different printer and cover different part instances.
      </p>

      <fieldset className="stack-row">
        <legend id={`${fieldPrefix}-source-legend`} className="text-body font-medium">
          Where is the print file?
        </legend>
        <RadioGroup
          aria-labelledby={`${fieldPrefix}-source-legend`}
          className="gap-[var(--space-row)]"
          name={`${fieldPrefix}-source`}
          value={source ?? ""}
          onValueChange={(next) => setSource(next as FileSource)}
        >
          <label
            htmlFor={`${fieldPrefix}-source-printer`}
            className="flex min-h-11 items-start gap-2 py-1 text-body"
          >
            <RadioGroupItem
              id={`${fieldPrefix}-source-printer`}
              value="printer"
              size="shop"
              className="mt-1.5"
            />
            <span>
              <span className="block font-medium">On a printer PrintPartner watches</span>
              <span className="block text-meta text-muted-foreground">
                Browse that printer's own storage and pick the file it ran.
              </span>
            </span>
          </label>
          <label
            htmlFor={`${fieldPrefix}-source-computer`}
            className="flex min-h-11 items-start gap-2 py-1 text-body"
          >
            <RadioGroupItem
              id={`${fieldPrefix}-source-computer`}
              value="computer"
              size="shop"
              className="mt-1.5"
            />
            <span>
              <span className="block font-medium">On this computer</span>
              <span className="block text-meta text-muted-foreground">
                Upload G-code, binary G-code, or a 3MF. This is the way in for a printer
                PrintPartner cannot talk to.
              </span>
            </span>
          </label>
        </RadioGroup>
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

      {source === "printer" && fleet.view.status === "ready" ? (
        <div className="stack-section">
          {watched.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-strong p-4 text-body text-muted-foreground">
              {desks.length === 0
                ? "PrintPartner has no printers yet, so there is no storage to browse."
                : "None of your printers has a linked host, so there is no storage to browse."}{" "}
              Choose On this computer and upload the file instead, or{" "}
              <Link className="underline" to={settingsPrintersRoute()}>
                add the printer in settings
              </Link>
              .
            </p>
          ) : (
            <div className="stack-row">
              <label className="text-body font-medium" htmlFor={`${fieldPrefix}-printer`}>
                Which printer made this print or plate?
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
                    finish({
                      filename: link.filename,
                      unitCount: link.units.length,
                      // This path hands the file to the shared assignment form,
                      // which does not ask whether the parts were checked.
                      units: "awaiting_check",
                    })
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

      {source === "computer" && fleet.view.status === "ready" ? (
        <UploadedPrintRecord
          key={recorded.length}
          profileId={profileId}
          printers={desks.map((desk) => desk.printer)}
          onPrintRecorded={onRecorded}
          onProgressChanged={onProgressChanged}
          onFinished={(print) => setRecorded((current) => [...current, print])}
        />
      ) : null}
    </section>
  );
}

/** The file the operator picked, with the object labels this browser read from it. */
type ReadPrintFile = Readonly<{ file: File; objectNames: string[] }>;

/** A Bambu/Orca project whose off-plate objects need an operator decision. */
type ProjectObjectReview = Readonly<{
  file: File;
  plateObjectNames: string[];
  projectOnlyNames: string[];
}>;

/**
 * The link the record wrote, kept so a failed check-off can rerun on its own.
 *
 * Only the three fields the check-off needs, so a partial link from any caller
 * still satisfies it.
 */
type RecordedLink = Readonly<{
  id: string;
  filename: string;
  units: readonly PrinterCheckoffUnit[];
}>;

/**
 * Uploading a print file, then putting it on the record.
 *
 * One union rather than a bag of flags, so the states this route does not have,
 * such as uploading a file whose bytes were never read, cannot be built. The
 * chosen file is carried by every phase after it is read, which is what lets a
 * failed upload or a failed save rerun without asking for the file again.
 *
 * The last two phases carry the link the record already wrote. That is the
 * difference the operator has to be told about: the print is on the record from
 * `checking_off` onwards, so nothing in those phases may offer to record it
 * again, and only the check-off is worth rerunning.
 */
type UploadState =
  | { phase: "choosing" }
  | { phase: "reading"; filename: string }
  | { phase: "read_failed"; filename: string; message: string }
  | { phase: "reviewing_project_objects"; review: ProjectObjectReview }
  | { phase: "uploading"; chosen: ReadPrintFile }
  | { phase: "upload_failed"; chosen: ReadPrintFile; message: string }
  | { phase: "confirming"; chosen: ReadPrintFile; check: UploadedPrintFileCheck }
  | { phase: "saving"; chosen: ReadPrintFile; check: UploadedPrintFileCheck }
  | {
      phase: "save_failed";
      chosen: ReadPrintFile;
      check: UploadedPrintFileCheck;
      message: string;
    }
  | {
      phase: "checking_off";
      chosen: ReadPrintFile;
      check: UploadedPrintFileCheck;
      link: RecordedLink;
    }
  | {
      phase: "checkoff_failed";
      chosen: ReadPrintFile;
      check: UploadedPrintFileCheck;
      link: RecordedLink;
      message: string;
    };

/**
 * The phases that have a checked file on screen, with the file and its check.
 *
 * A switch rather than a chain of comparisons, so a new phase has to say
 * whether it shows the file instead of silently falling out of the form.
 */
function answeredFile(
  state: UploadState,
): Readonly<{ chosen: ReadPrintFile; check: UploadedPrintFileCheck }> | null {
  switch (state.phase) {
    case "confirming":
    case "saving":
    case "save_failed":
    case "checking_off":
    case "checkoff_failed":
      return { chosen: state.chosen, check: state.check };
    case "choosing":
    case "reading":
    case "read_failed":
    case "reviewing_project_objects":
    case "uploading":
    case "upload_failed":
      return null;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/**
 * Which machine the operator says ran this print.
 *
 * Null until it is answered. A printer PrintPartner does not manage is a real
 * answer rather than a blank, because that is the usual case for a print made
 * elsewhere, so the form has to tell the two apart.
 */
type PrinterAnswer = { kind: "fleet"; printerId: string } | { kind: "unmanaged" };

/** Whether the operator has already looked at the parts this print made. */
type CheckedAnswer = "checked" | "not_checked";

function printerSelectValue(answer: PrinterAnswer | null): string {
  if (answer === null) return "";
  switch (answer.kind) {
    case "fleet":
      return answer.printerId;
    case "unmanaged":
      return UNMANAGED_PRINTER_ID;
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}

function readPrinterAnswer(value: string): PrinterAnswer | null {
  if (value === "") return null;
  return isUnmanagedPrinterId(value) ? { kind: "unmanaged" } : { kind: "fleet", printerId: value };
}

/** One problem with the record form, named by the field it belongs to. */
type RecordFieldError = Readonly<{
  field: "printer" | "units" | "checked";
  message: string;
}>;

function recordProblems(input: {
  printer: PrinterAnswer | null;
  confirmedUnitCount: number;
  checked: CheckedAnswer | null;
}): RecordFieldError[] {
  const problems: RecordFieldError[] = [];
  if (input.printer === null) {
    problems.push({ field: "printer", message: "Say which printer made this print" });
  }
  if (input.confirmedUnitCount === 0) {
    problems.push({
      field: "units",
      message: "Confirm at least one Required unit this print covers",
    });
  }
  if (input.checked === null) {
    problems.push({ field: "checked", message: "Say whether you have checked the parts" });
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
  onPrintRecorded,
  onProgressChanged,
  onFinished,
}: {
  profileId: number;
  printers: readonly PrinterMachine[];
  /**
   * The print is on the record. Fires before the units are checked off, because
   * the record stands whether or not the check-off that follows it succeeds.
   */
  onPrintRecorded: () => void;
  onProgressChanged: () => void;
  /** Nothing is left to do here, and this is what is now true. */
  onFinished: (print: RecordedPrint) => void;
}) {
  const fieldPrefix = useId();
  const printerErrorId = `${fieldPrefix}-printer-error`;
  const unitsErrorId = `${fieldPrefix}-units-error`;
  const checkedErrorId = `${fieldPrefix}-checked-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [printer, setPrinter] = useState<PrinterAnswer | null>(null);
  const [confirmedTokens, setConfirmedTokens] = useState<ReadonlySet<string>>(new Set());
  const [checked, setChecked] = useState<CheckedAnswer | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>({ phase: "choosing" });

  const problems = recordProblems({
    printer,
    confirmedUnitCount: confirmedTokens.size,
    checked,
  });
  const visibleProblems = showProblems ? problems : [];
  const printerProblem = visibleProblems.find((problem) => problem.field === "printer") ?? null;
  const unitsProblem = visibleProblems.find((problem) => problem.field === "units") ?? null;
  const checkedProblem = visibleProblems.find((problem) => problem.field === "checked") ?? null;

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
      if (parsed.format === "3mf" && parsed.projectOnlyNames.length > 0) {
        setState({
          phase: "reviewing_project_objects",
          review: {
            file,
            plateObjectNames: parsed.names,
            projectOnlyNames: parsed.projectOnlyNames,
          },
        });
        return;
      }
      await upload({ file, objectNames: parsed.names });
    } catch (error) {
      setState({
        phase: "read_failed",
        filename: file.name,
        message: failureMessage(error, "The file could not be read."),
      });
    }
  };

  /**
   * Check the confirmed units off through the verify the operator would run in
   * Checkoff, at the moment they already have the answer.
   *
   * No second way to mark a unit printed: the same per-unit decisions, sent
   * from here. A failure leaves a print that really is on the record with units
   * that really are not checked off, which is why it reruns on its own.
   */
  const checkOff = async (input: {
    chosen: ReadPrintFile;
    check: UploadedPrintFileCheck;
    link: RecordedLink;
  }) => {
    setState({ phase: "checking_off", ...input });
    const decisions = input.link.units.map(
      (unit): PrintVerifyDecision => ({
        part_id: unit.part_id,
        unit_index: unit.unit_index,
        result: "confirmed",
      }),
    );
    try {
      await verifyPrinterCheckoff({ link_id: input.link.id, decisions });
    } catch (error) {
      setState({
        phase: "checkoff_failed",
        ...input,
        message: failureMessage(error, "The server did not check the units off."),
      });
      return;
    }
    onProgressChanged();
    onFinished({
      filename: input.link.filename,
      unitCount: decisions.length,
      units: "checked_off",
    });
  };

  const record = async (chosen: ReadPrintFile, check: UploadedPrintFileCheck) => {
    setShowProblems(true);
    if (problems.length > 0 || printer === null || checked === null) return;
    setState({ phase: "saving", chosen, check });
    let link: RecordedLink | null = null;
    try {
      const result = await assignUploadedPrinterFile({
        profile_id: profileId,
        // Omitted for a printer PrintPartner does not manage. The server records
        // those against UNMANAGED_PRINTER_ID, so no hardware has to be
        // registered just to say a print happened.
        ...(printer.kind === "fleet" ? { printer_id: printer.printerId } : {}),
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
      link = result.link;
    } catch (error) {
      setState({
        phase: "save_failed",
        chosen,
        check,
        message: failureMessage(error, "The server did not accept the record."),
      });
    }
    if (link === null) return;

    // The print is on the record from here on, whatever the check-off does.
    onPrintRecorded();
    if (checked === "not_checked") {
      onFinished({
        filename: link.filename,
        unitCount: link.units.length,
        units: "awaiting_check",
      });
      return;
    }
    await checkOff({ chosen, check, link });
  };

  const file = answeredFile(state);
  const answered = file
    ? {
        ...file,
        summary: printFileCheckSummary({
          preview: file.check,
          filename: file.chosen.file.name,
          // Nothing here goes to a printer. The print already happened, so the
          // file is what it was made from, and print-readiness has no say.
          intent: "record",
        }),
      }
    : null;
  const busy =
    state.phase === "reading" ||
    state.phase === "uploading" ||
    state.phase === "saving" ||
    state.phase === "checking_off";
  // The record is written, so the form is history and must not be resubmitted.
  const written = state.phase === "checking_off" || state.phase === "checkoff_failed";
  const hasChosenFile = answered !== null || state.phase === "reviewing_project_objects";

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
          disabled={busy || written}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1.5 h-4 w-4" aria-hidden />
          {hasChosenFile ? "Choose a different file" : "Choose the print file"}
        </Button>
        <p className="text-meta text-muted-foreground">
          PrintPartner reads the file you upload and says what it is. A slicer project is fine
          here, because this file is the record of a print that already happened, not something
          PrintPartner is about to run.
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

      {state.phase === "reviewing_project_objects" ? (
        <section
          aria-label="Project-only 3MF objects"
          className={cn(
            "stack-row rounded-md p-3",
            statusTone({ tone: "warning", emphasis: "surface" }),
          )}
        >
          <p className="font-mono text-body font-semibold">{state.review.file.name}</p>
          <p className="text-body font-medium text-warning">
            {state.review.plateObjectNames.length} object
            {state.review.plateObjectNames.length === 1 ? "" : "s"} assigned to a plate
          </p>
          <p className="text-body">
            {state.review.projectOnlyNames.length} more object
            {state.review.projectOnlyNames.length === 1 ? "" : "s"} stored only in the project.
            Bambu did not assign {state.review.projectOnlyNames.length === 1 ? "it" : "them"} to
            a printable plate. Include {state.review.projectOnlyNames.length === 1 ? "it" : "them"}
            only if {state.review.projectOnlyNames.length === 1 ? "it was" : "they were"} printed.
          </p>
          <ul
            className={cn(
              "max-h-40 overflow-y-auto rounded-md bg-background p-2 font-mono text-micro",
              statusTone({ tone: "warning", emphasis: "edge" }),
            )}
          >
            {state.review.projectOnlyNames.map((name, index) => (
              <li key={`${name}:${index}`} className="truncate" title={name}>
                {name}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="shop"
              variant="outline"
              onClick={() =>
                void upload({
                  file: state.review.file,
                  objectNames: state.review.plateObjectNames,
                })
              }
            >
              Use plate objects only
            </Button>
            <Button
              size="shop"
              onClick={() =>
                void upload({
                  file: state.review.file,
                  objectNames: [
                    ...state.review.plateObjectNames,
                    ...state.review.projectOnlyNames,
                  ],
                })
              }
            >
              {`Include all ${
                state.review.plateObjectNames.length + state.review.projectOnlyNames.length
              } project objects`}
            </Button>
          </div>
        </section>
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
                  className={cn(
                    "rounded-md p-3",
                    statusTone({ tone: "error", emphasis: "soft" }),
                  )}
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
                  value={printerSelectValue(printer)}
                  disabled={written}
                  aria-invalid={printerProblem ? true : undefined}
                  aria-describedby={printerProblem ? printerErrorId : undefined}
                  onChange={(event) => setPrinter(readPrinterAnswer(event.target.value))}
                >
                  <option value="">Choose an answer…</option>
                  {printers.length > 0 ? (
                    <optgroup label="Your printers">
                      {printers.map((machine) => (
                        <option key={machine.id} value={machine.id}>
                          {machine.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  <option value={UNMANAGED_PRINTER_ID}>{UNMANAGED_PRINTER_NAME}</option>
                </select>
                <p className="text-meta text-muted-foreground">
                  A print made elsewhere does not need a registered printer. Pick the last answer
                  when PrintPartner does not manage the machine that ran it.
                </p>
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
                disabled={written}
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

              <fieldset
                className="stack-row"
                disabled={written}
                aria-invalid={checkedProblem ? true : undefined}
                aria-describedby={checkedProblem ? checkedErrorId : undefined}
              >
                <legend id={`${fieldPrefix}-checked-legend`} className="text-body font-medium">
                  Have you checked the parts?
                </legend>
                <RadioGroup
                  aria-labelledby={`${fieldPrefix}-checked-legend`}
                  className="gap-[var(--space-row)]"
                  name={`${fieldPrefix}-checked`}
                  value={checked ?? ""}
                  onValueChange={(next) => setChecked(next as CheckedAnswer)}
                >
                  <label
                    htmlFor={`${fieldPrefix}-checked-yes`}
                    className="flex min-h-11 items-start gap-2 py-1 text-body"
                  >
                    <RadioGroupItem
                      id={`${fieldPrefix}-checked-yes`}
                      value="checked"
                      size="shop"
                      className="mt-1.5"
                    />
                    <span>
                      <span className="block font-medium">Printed and checked</span>
                      <span className="block text-meta text-muted-foreground">
                        You have looked at the parts and they are good. The confirmed units are
                        checked off as soon as this is recorded.
                      </span>
                    </span>
                  </label>
                  <label
                    htmlFor={`${fieldPrefix}-checked-no`}
                    className="flex min-h-11 items-start gap-2 py-1 text-body"
                  >
                    <RadioGroupItem
                      id={`${fieldPrefix}-checked-no`}
                      value="not_checked"
                      size="shop"
                      className="mt-1.5"
                    />
                    <span>
                      <span className="block font-medium">Printed, not checked yet</span>
                      <span className="block text-meta text-muted-foreground">
                        The units wait in Checkoff until you have looked at the parts. Reject one
                        there if it came out wrong.
                      </span>
                    </span>
                  </label>
                </RadioGroup>
                {checkedProblem ? (
                  <p id={checkedErrorId} className="text-meta text-destructive">
                    {checkedProblem.message}
                  </p>
                ) : null}
              </fieldset>

              {state.phase === "save_failed" ? (
                <InlineOperationError
                  title={`Could not record ${state.chosen.file.name}`}
                  message={state.message}
                  onRetry={() => void record(state.chosen, state.check)}
                  retryLabel="Record again"
                />
              ) : null}

              {state.phase === "checking_off" ? (
                <p className="text-body text-muted-foreground" role="status">
                  Checking {requiredUnitCount(state.link.units.length)} off…
                </p>
              ) : null}

              {state.phase === "checkoff_failed" ? (
                <div className="stack-row">
                  <InlineOperationError
                    title={`${state.link.filename} is on the record, and its units are not checked off`}
                    message={`${state.message} The print itself was recorded, so do not record it again. ${requiredUnitCount(
                      state.link.units.length,
                    )} ${state.link.units.length === 1 ? "is" : "are"} still waiting to be checked.`}
                    onRetry={() =>
                      void checkOff({
                        chosen: state.chosen,
                        check: state.check,
                        link: state.link,
                      })
                    }
                    retryLabel="Check the units off again"
                  />
                  <Button
                    size="shop"
                    variant="outline"
                    className="self-start"
                    onClick={() =>
                      onFinished({
                        filename: state.link.filename,
                        unitCount: state.link.units.length,
                        units: "awaiting_check",
                      })
                    }
                  >
                    Leave the units for Checkoff
                  </Button>
                </div>
              ) : null}

              {written ? null : (
                <Button
                  size="shop"
                  className="self-start"
                  loading={state.phase === "saving"}
                  onClick={() => void record(answered.chosen, answered.check)}
                >
                  Record this print
                </Button>
              )}
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
  disabled,
  onToggle,
  errorId,
  error,
}: {
  units: readonly PrinterCheckoffUnit[];
  caption: string;
  unlabeledNames: readonly string[];
  confirmedTokens: ReadonlySet<string>;
  /** True once the record is written, so the answers are history to read. */
  disabled: boolean;
  onToggle: (token: string, confirmed: boolean) => void;
  errorId: string;
  error: RecordFieldError | null;
}) {
  const unitIdPrefix = useId();
  return (
    <fieldset
      className="stack-row"
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-body font-medium">Which Required units did this print cover?</legend>
      <p className="text-meta text-muted-foreground">{caption}</p>

      {units.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-background p-2">
          {units.map((unit) => {
            const token = requiredUnitToken(unit);
            /* Named through `for`: a <label> wrapper does not name a button
               with role="checkbox". */
            const unitId = `${unitIdPrefix}-${token}`;
            return (
              <li key={token}>
                <label
                  htmlFor={unitId}
                  className="flex min-h-11 items-center gap-2 py-1 text-body"
                >
                  <Checkbox
                    id={unitId}
                    size="shop"
                    className="shrink-0"
                    checked={confirmedTokens.has(token)}
                    onCheckedChange={(next) => onToggle(token, next === true)}
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
        <div
          className={cn(
            "rounded-md p-2.5",
            statusTone({ tone: "warning", emphasis: "surface" }),
          )}
        >
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

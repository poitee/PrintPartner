import { useId, useState } from "react";
import { Download } from "lucide-react";
import type { ProfileSummary } from "@print-partner/contracts";
import {
  assignPrinterFile,
  previewPrinterFileAssignment,
  type PrinterCheckoffLink,
  type PrintFileAssignmentPreview,
} from "../../api/endpoints/checkoff";
import {
  printerStoredFileUrl,
  type PrinterMachine,
} from "../../api/endpoints/printers";
import type { IntegrationSummary } from "../../api/endpoints/integrations";
import { Button } from "../ui/button";
import { StatusBadge } from "../ui/status-badge";
import InlineOperationError from "./InlineOperationError";
import { failureMessage } from "./asyncView";
import {
  printFileCheckSummary,
  type PrintFileCheckSummary,
} from "./printFileClassification";
import {
  chosenBuildId,
  requiredUnitToken,
  validatePrintFileAssignment,
  type AssignFieldError,
} from "./printFileAssignment";

/** A print file the operator picked, with the object labels found in its bytes. */
export type ChosenPrintFile = Readonly<{
  file: File;
  /** Set when the bytes came from the printer host rather than the operator's computer. */
  remotePath?: string;
  objectNames: string[];
}>;

type Props = {
  printer: PrinterMachine;
  /** Null when no host watches this printer, so only manual tracking is offered. */
  host: IntegrationSummary | null;
  profiles: ProfileSummary[];
  selectedProfileId: number | null;
  chosen: ChosenPrintFile;
  onCancel: () => void;
  onAssigned: (link: PrinterCheckoffLink) => void;
};

/**
 * Check a print file, then commit the mapping the operator confirmed.
 *
 * Two steps on purpose. The check writes nothing and answers with what
 * PrintPartner proved about the bytes plus the Required units it thinks the file
 * covers. Only after the operator has seen that, and confirmed which units to
 * link, does anything get written. Nobody is asked to promise that a 3MF is
 * sliced: the server reads the file and says so.
 */
type AssignState =
  | { phase: "unchecked" }
  | { phase: "checking" }
  | { phase: "check_failed"; message: string }
  | { phase: "confirming"; preview: PrintFileAssignmentPreview }
  | { phase: "saving"; preview: PrintFileAssignmentPreview }
  | { phase: "save_failed"; preview: PrintFileAssignmentPreview; message: string };

/** Which decisions have been submitted, and therefore whose problems to show. */
type ErrorGate = "none" | "check" | "save";

export default function PrintFileAssignForm({
  printer,
  host,
  profiles,
  selectedProfileId,
  chosen,
  onCancel,
  onAssigned,
}: Props) {
  const fieldPrefix = useId();
  const buildFieldId = `${fieldPrefix}-build`;
  const buildErrorId = `${fieldPrefix}-build-error`;
  const unitsErrorId = `${fieldPrefix}-units-error`;

  const [buildValue, setBuildValue] = useState(
    selectedProfileId == null ? "" : String(selectedProfileId),
  );
  const [tracking, setTracking] = useState<"host" | "manual">(host ? "host" : "manual");
  const [completed, setCompleted] = useState(false);
  const [confirmedTokens, setConfirmedTokens] = useState<ReadonlySet<string>>(new Set());
  const [errorGate, setErrorGate] = useState<ErrorGate>("none");
  const [assign, setAssign] = useState<AssignState>({ phase: "unchecked" });

  const buildId = chosenBuildId(buildValue);
  const errors = validatePrintFileAssignment({
    buildId,
    confirmedUnitCount: confirmedTokens.size,
    completed,
  });
  // The units question only exists once a check has answered, so before the
  // save is submitted only the Build problem is worth showing.
  const visibleErrors =
    errorGate === "none"
      ? []
      : errors.filter((error) => errorGate === "save" || error.field === "build");
  const buildError = visibleErrors.find((error) => error.field === "build") ?? null;
  const unitsError = visibleErrors.find((error) => error.field === "units") ?? null;

  const check = async () => {
    setErrorGate("check");
    if (buildId == null) return;
    setAssign({ phase: "checking" });
    try {
      const preview = await previewPrinterFileAssignment({
        profile_id: buildId,
        printer_id: printer.id,
        filename: chosen.file.name,
        remote_path: chosen.remotePath,
        object_names: chosen.objectNames,
      });
      setConfirmedTokens(new Set(preview.suggested_units.map(requiredUnitToken)));
      setErrorGate("none");
      setAssign({ phase: "confirming", preview });
    } catch (error) {
      setAssign({
        phase: "check_failed",
        message: failureMessage(error, "The server did not answer the check."),
      });
    }
  };

  const save = async (preview: PrintFileAssignmentPreview) => {
    setErrorGate("save");
    if (errors.length > 0 || buildId == null) return;
    setAssign({ phase: "saving", preview });
    try {
      const result = await assignPrinterFile({
        profile_id: buildId,
        printer_id: printer.id,
        filename: chosen.file.name,
        remote_path: chosen.remotePath,
        object_names: chosen.objectNames,
        tracking,
        completed,
        plan_revision_id: preview.plan_revision_id,
        unit_tokens: [...confirmedTokens],
      });
      onAssigned(result.link);
    } catch (error) {
      setAssign({
        phase: "save_failed",
        preview,
        message: failureMessage(error, "The server did not accept the assignment."),
      });
    }
  };

  const busy = assign.phase === "checking" || assign.phase === "saving";
  const answered =
    assign.phase === "confirming" || assign.phase === "saving" || assign.phase === "save_failed"
      ? {
          preview: assign.preview,
          summary: printFileCheckSummary({
            preview: assign.preview,
            filename: chosen.file.name,
          }),
        }
      : null;

  return (
    <section
      aria-label={`Assign ${chosen.file.name}`}
      className="stack-section rounded-lg border border-primary/25 bg-primary/5 p-4"
    >
      <div className="min-w-0">
        <h3 className="truncate font-mono text-body font-semibold" title={chosen.file.name}>
          {chosen.file.name}
        </h3>
        <p className="text-meta text-muted-foreground">
          {chosen.objectNames.length > 0
            ? `${chosen.objectNames.length} object label${chosen.objectNames.length === 1 ? "" : "s"} read from the file`
            : "No object labels in the file. PrintPartner will try the file name."}
        </p>
      </div>

      <AssignErrorSummary errors={visibleErrors} />

      <div className="stack-row">
        <label className="text-body font-medium" htmlFor={buildFieldId}>
          Assign to Build
        </label>
        <select
          id={buildFieldId}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-body"
          value={buildValue}
          aria-invalid={buildError ? true : undefined}
          aria-describedby={buildError ? buildErrorId : undefined}
          onChange={(event) => {
            setBuildValue(event.target.value);
            // A check answers for one Build's Accepted Plan revision, so it
            // stops being an answer the moment the Build changes.
            setConfirmedTokens(new Set());
            setAssign({ phase: "unchecked" });
          }}
        >
          <option value="">Choose a Build…</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        {buildError ? (
          <p id={buildErrorId} className="text-meta text-destructive">
            {buildError.message}
          </p>
        ) : null}
      </div>

      <fieldset className="stack-row">
        <legend className="text-body font-medium">How should PrintPartner track it?</legend>
        {host ? (
          <label className="flex items-start gap-2 text-body">
            <input
              type="radio"
              className="mt-1 h-4 w-4"
              name={`${fieldPrefix}-tracking`}
              checked={tracking === "host"}
              onChange={() => setTracking("host")}
            />
            <span>
              <span className="block font-medium">Watch this printer</span>
              <span className="block text-meta text-muted-foreground">
                Match the file name when {host.name} reports the current or next print.
              </span>
            </span>
          </label>
        ) : null}
        <label className="flex items-start gap-2 text-body">
          <input
            type="radio"
            className="mt-1 h-4 w-4"
            name={`${fieldPrefix}-tracking`}
            checked={tracking === "manual"}
            onChange={() => setTracking("manual")}
          />
          <span>
            <span className="block font-medium">Track it by hand</span>
            <span className="block text-meta text-muted-foreground">
              You mark it finished in the Tracked tab. Use this when the printer cannot report
              status.
            </span>
          </span>
        </label>
      </fieldset>

      {assign.phase === "unchecked" ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="shop" onClick={() => void check()}>
            Check this file
          </Button>
        </div>
      ) : null}

      {assign.phase === "checking" ? (
        <p className="text-body text-muted-foreground" role="status">
          Checking {chosen.file.name}…
        </p>
      ) : null}

      {assign.phase === "check_failed" ? (
        <InlineOperationError
          title={`Could not check ${chosen.file.name}`}
          message={assign.message}
          onRetry={() => void check()}
          retryLabel="Check again"
        />
      ) : null}

      {answered ? (
        <>
          <CheckPanel
            summary={answered.summary}
            printer={printer}
            remotePath={chosen.remotePath}
          />

          {answered.summary.assignable ? (
            <>
              <UnitConfirmation
                preview={answered.preview}
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
                error={unitsError}
              />

              <label className="flex items-start gap-2 rounded-md border border-border bg-background p-3 text-body">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={completed}
                  onChange={(event) => setCompleted(event.target.checked)}
                />
                <span>
                  <span className="block font-medium">This print is already finished</span>
                  <span className="block text-meta text-muted-foreground">
                    Send it straight to Checkoff instead of waiting for a host or a manual finish.
                  </span>
                </span>
              </label>

              {assign.phase === "save_failed" ? (
                <InlineOperationError
                  title={`Could not assign ${chosen.file.name}`}
                  message={assign.message}
                  onRetry={() => void save(assign.preview)}
                  retryLabel="Assign again"
                />
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  size="shop"
                  loading={assign.phase === "saving"}
                  onClick={() => void save(answered.preview)}
                >
                  {completed ? "Assign and send to Checkoff" : "Assign print file"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={onCancel}>
                Choose another file
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

/**
 * Every problem with the form, above the form.
 *
 * GOV.UK pairs a summary with the message beside each field: the summary says
 * how many decisions are unresolved, the field says which one.
 */
function AssignErrorSummary({ errors }: { errors: readonly AssignFieldError[] }) {
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-destructive"
    >
      <p className="text-body font-semibold">
        {errors.length === 1
          ? "1 decision still needs your answer"
          : `${errors.length} decisions still need your answer`}
      </p>
      <ul className="mt-1 list-disc pl-5 text-meta">
        {errors.map((error) => (
          <li key={error.field}>{error.message}</li>
        ))}
      </ul>
    </div>
  );
}

/** What the server proved about the file, and what it means for the operator. */
function CheckPanel({
  summary,
  printer,
  remotePath,
}: {
  summary: PrintFileCheckSummary;
  printer: PrinterMachine;
  remotePath?: string;
}) {
  return (
    <div className="stack-row rounded-md border border-border bg-background p-3">
      <StatusBadge status={summary.status} label={summary.headline} live />
      <p className="text-body">{summary.nextStep}</p>
      {!summary.assignable && remotePath ? (
        <Button size="shop" variant="outline" asChild>
          <a href={printerStoredFileUrl({ printerId: printer.id, path: remotePath })} download>
            <Download className="mr-1.5 h-4 w-4" aria-hidden />
            Download a copy
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/** The mapping the operator has to agree with before anything is written. */
function UnitConfirmation({
  preview,
  confirmedTokens,
  onToggle,
  errorId,
  error,
}: {
  preview: PrintFileAssignmentPreview;
  confirmedTokens: ReadonlySet<string>;
  onToggle: (token: string, confirmed: boolean) => void;
  errorId: string;
  error: AssignFieldError | null;
}) {
  return (
    <fieldset
      className="stack-row"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-body font-medium">Confirm the Required units</legend>
      <p className="text-meta text-muted-foreground">{basisCaption(preview.suggestion_basis)}</p>

      {preview.suggested_units.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-background p-2">
          {preview.suggested_units.map((unit) => {
            const token = requiredUnitToken(unit);
            return (
              <li key={token}>
                <label className="flex items-center gap-2 py-1 text-body">
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

      {preview.unlabeled_names.length > 0 ? (
        <div className="rounded-md border border-warning/35 bg-warning-soft p-2.5">
          <p className="text-meta font-medium text-warning">
            {preview.unlabeled_names.length} object name
            {preview.unlabeled_names.length === 1 ? "" : "s"} matched no Required unit
          </p>
          <ul className="mt-1 font-mono text-micro text-warning">
            {preview.unlabeled_names.map((name) => (
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

function basisCaption(basis: PrintFileAssignmentPreview["suggestion_basis"]): string {
  switch (basis) {
    case "object_names":
      return "Matched from the object labels inside the file. Clear anything this print does not cover.";
    case "filename":
      return "Matched from the file name, because the file carries no object labels. Check it before you assign.";
    case "none":
      return "Nothing in this file matched a Required unit. Assign it anyway to keep the record, then check off by hand.";
    default: {
      const _exhaustive: never = basis;
      return _exhaustive;
    }
  }
}

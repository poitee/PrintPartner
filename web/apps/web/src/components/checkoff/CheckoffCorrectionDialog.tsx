import { useEffect, useRef, useState } from "react";
import {
  CHECKOFF_CORRECTION_NOTE_MAX,
  CHECKOFF_CORRECTION_REASONS,
  checkoffCorrectionNeedsReason,
  describeCheckoffCorrectionImpact,
  validateCheckoffCorrection,
  type CheckoffCorrectionImpact,
  type CheckoffCorrectionReason,
} from "../../lib/checkoffConsoleCorrection";
import { describeCheckoffMutationFailure } from "../../lib/checkoffConsoleRowErrors";
import { statusTone } from "../../lib/statusTone";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

export type CheckoffCorrectionTarget = {
  partId: number;
  filename: string;
  printedCount: number;
  scope?: "one" | "all";
  impact: CheckoffCorrectionImpact;
};

type Props = {
  target: CheckoffCorrectionTarget | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (input: {
    reason: CheckoffCorrectionReason | null;
    note: string;
  }) => Promise<void>;
};

/**
 * Short correction flow for taking a unit back off the printed count.
 *
 * When the unit carries printer history or tracked filament, the operator
 * states a reason before the count changes. That keeps the record honest
 * without forcing a form on a plain mis-tap.
 */
export default function CheckoffCorrectionDialog({
  target,
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  const [reason, setReason] = useState<CheckoffCorrectionReason | null>(null);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const submissionIdRef = useRef(0);

  useEffect(() => {
    submissionIdRef.current += 1;
    savingRef.current = false;
    setReason(null);
    setNote("");
    setSubmitted(false);
    setSaving(false);
    setSubmitError(null);
  }, [target]);

  const needsReason = target ? checkoffCorrectionNeedsReason(target.impact) : false;
  const validation = validateCheckoffCorrection({ draft: { reason, note }, needsReason });
  const showErrors = (submitted && !validation.ok) || submitError != null;
  const disabled = busy || saving;

  useEffect(() => {
    if (showErrors) summaryRef.current?.focus();
  }, [showErrors]);

  const reasonError = validation.errors.find((error) => error.field === "reason");
  const noteError = validation.errors.find((error) => error.field === "note");

  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open && !busy && !savingRef.current) onCancel();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby="checkoff-correction-impact">
        <DialogHeader>
          <DialogTitle>
            {target?.scope === "all" ? "Clear all printed copies of" : "Take one unit off"}{" "}
            {target?.filename ?? "this part"}
          </DialogTitle>
          <p id="checkoff-correction-impact" className="text-sm text-muted-foreground">
            {target ? describeCheckoffCorrectionImpact(target.impact) : ""}
          </p>
        </DialogHeader>

        {showErrors ? (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className={cn(
              "rounded-md p-3 text-sm",
              statusTone({ tone: "error", emphasis: "surface" }),
            )}
          >
            <p className="font-semibold text-destructive">There is a problem</p>
            {submitted && !validation.ok ? (
              <ul className="mt-1 list-disc pl-5 text-destructive">
                {validation.errors.map((error) => (
                  <li key={error.field}>{error.message}</li>
                ))}
              </ul>
            ) : null}
            {submitError ? <p className="mt-1 text-destructive">{submitError}</p> : null}
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="checkoff-correction-reason" className="text-sm font-medium">
              Reason{needsReason ? "" : " (optional)"}
            </label>
            {showErrors && reasonError ? (
              <p id="checkoff-correction-reason-error" className="text-sm text-destructive">
                {reasonError.message}
              </p>
            ) : null}
            <select
              id="checkoff-correction-reason"
              className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
              disabled={disabled}
              value={reason ?? ""}
              aria-describedby={
                showErrors && reasonError ? "checkoff-correction-reason-error" : undefined
              }
              aria-invalid={showErrors && reasonError ? true : undefined}
              onChange={(event) =>
                setReason(
                  event.target.value ? (event.target.value as CheckoffCorrectionReason) : null,
                )
              }
            >
              <option value="">Choose a reason</option>
              {CHECKOFF_CORRECTION_REASONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="checkoff-correction-note" className="text-sm font-medium">
              Note (optional)
            </label>
            {showErrors && noteError ? (
              <p id="checkoff-correction-note-error" className="text-sm text-destructive">
                {noteError.message}
              </p>
            ) : null}
            <input
              id="checkoff-correction-note"
              type="text"
              className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
              disabled={disabled}
              value={note}
              maxLength={CHECKOFF_CORRECTION_NOTE_MAX}
              aria-describedby={
                showErrors && noteError ? "checkoff-correction-note-error" : undefined
              }
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
          <Button
            type="button"
            className="min-h-11"
            disabled={disabled}
            aria-busy={saving || undefined}
            onClick={async () => {
              setSubmitted(true);
              if (!validateCheckoffCorrection({ draft: { reason, note }, needsReason }).ok) return;
              if (savingRef.current) return;
              savingRef.current = true;
              const submissionId = submissionIdRef.current + 1;
              submissionIdRef.current = submissionId;
              setSaving(true);
              setSubmitError(null);
              try {
                await onConfirm({ reason, note });
              } catch (cause: unknown) {
                if (submissionIdRef.current !== submissionId) return;
                setSubmitError(
                  describeCheckoffMutationFailure({
                    action: "correction",
                    filename: target?.filename ?? "this part",
                    cause,
                  }),
                );
              } finally {
                if (submissionIdRef.current === submissionId) {
                  savingRef.current = false;
                  setSaving(false);
                }
              }
            }}
          >
            {saving ? "Saving…" : "Save correction"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={disabled}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

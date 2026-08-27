/**
 * Correction flow for manual Checkoff edits.
 *
 * Marking a unit printed is cheap to undo when nothing else depends on it. It
 * is not cheap when a printer job already recorded that unit, or when the unit
 * consumed a filament that the shop deducts. Those corrections change history,
 * so the operator states a reason first.
 *
 * A successful printer status never marks a unit printed on its own. Human
 * verification stays required, so a correction always has a person behind it.
 */

export type CheckoffCorrectionReason =
  | "wrong_row"
  | "print_failed"
  | "part_damaged"
  | "wrong_filament"
  | "recount"
  | "other";

export const CHECKOFF_CORRECTION_REASONS: readonly {
  value: CheckoffCorrectionReason;
  label: string;
}[] = [
  { value: "wrong_row", label: "Marked the wrong part" },
  { value: "print_failed", label: "Print failed after checkoff" },
  { value: "part_damaged", label: "Part damaged or scrapped" },
  { value: "wrong_filament", label: "Wrong filament" },
  { value: "recount", label: "Recounted the bin" },
  { value: "other", label: "Other" },
];

export function isCheckoffCorrectionReason(
  value: unknown,
): value is CheckoffCorrectionReason {
  return CHECKOFF_CORRECTION_REASONS.some((reason) => reason.value === value);
}

export function checkoffCorrectionReasonLabel(
  value: CheckoffCorrectionReason,
): string {
  return (
    CHECKOFF_CORRECTION_REASONS.find((reason) => reason.value === value)?.label ??
    "Other"
  );
}

export type CheckoffCorrectionImpact = {
  /** A printer job recorded this part, so undoing it rewrites printer history. */
  printerHistory: boolean;
  /** The unit consumed a tracked filament, so undoing it changes material use. */
  materialDeduction: boolean;
};

export function checkoffCorrectionImpact(input: {
  printingOn?: string | null;
  awaitingVerify?: string | null;
  verifiedByPrinter?: boolean;
  filamentDisplay?: string | null;
}): CheckoffCorrectionImpact {
  return {
    printerHistory: Boolean(
      input.printingOn || input.awaitingVerify || input.verifiedByPrinter,
    ),
    materialDeduction: Boolean(input.filamentDisplay?.trim()),
  };
}

export function checkoffCorrectionNeedsReason(
  impact: CheckoffCorrectionImpact,
): boolean {
  return impact.printerHistory || impact.materialDeduction;
}

/** One sentence naming what the correction changes, in plain words. */
export function describeCheckoffCorrectionImpact(
  impact: CheckoffCorrectionImpact,
): string {
  if (impact.printerHistory && impact.materialDeduction) {
    return "This unit came from a printer job and used tracked filament. The reason is kept with the correction.";
  }
  if (impact.printerHistory) {
    return "A printer job recorded this unit. The reason is kept with the correction.";
  }
  if (impact.materialDeduction) {
    return "This unit used tracked filament. The reason is kept with the correction.";
  }
  return "Nothing else depends on this unit.";
}

export type CheckoffCorrectionDraft = {
  reason: CheckoffCorrectionReason | null;
  note: string;
};

export const EMPTY_CHECKOFF_CORRECTION: CheckoffCorrectionDraft = {
  reason: null,
  note: "",
};

export const CHECKOFF_CORRECTION_NOTE_MAX = 500;

export type CheckoffCorrectionValidation = {
  ok: boolean;
  /** Field id -> message, for an error summary plus inline messages. */
  errors: { field: "reason" | "note"; message: string }[];
};

export function validateCheckoffCorrection(input: {
  draft: CheckoffCorrectionDraft;
  needsReason: boolean;
}): CheckoffCorrectionValidation {
  const errors: CheckoffCorrectionValidation["errors"] = [];
  if (input.needsReason && input.draft.reason == null) {
    errors.push({ field: "reason", message: "Choose why you are correcting this unit" });
  }
  if (input.draft.note.length > CHECKOFF_CORRECTION_NOTE_MAX) {
    errors.push({
      field: "note",
      message: `Keep the note under ${CHECKOFF_CORRECTION_NOTE_MAX} characters`,
    });
  }
  return { ok: errors.length === 0, errors };
}

export type CheckoffCorrectionRecord = {
  partId: number;
  unitIndex: number;
  reason: CheckoffCorrectionReason;
  note: string;
  at: string;
};

export function formatCheckoffCorrection(record: CheckoffCorrectionRecord): string {
  const label = checkoffCorrectionReasonLabel(record.reason);
  const at = new Date(record.at);
  const when = Number.isNaN(at.getTime()) ? "" : ` on ${at.toLocaleString()}`;
  const note = record.note.trim() ? ` — ${record.note.trim()}` : "";
  return `Corrected${when}: ${label}${note}`;
}

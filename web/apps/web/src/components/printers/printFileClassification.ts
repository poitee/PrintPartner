import type { PrintFileClassification } from "@print-partner/contracts";
import type { PrintFileAssignmentPreview } from "../../api/endpoints/checkoff";
import type { WorkflowStatusKind } from "@/lib/statusTone";

/**
 * The classification in the operator's language.
 *
 * `headline` is the badge words. `nextStep` says what the file is, then what
 * follows from that. `downloadOnly` marks the one classification PrintPartner
 * hands back without tracking it as a print, which only the print path can
 * produce. Every field depends on the intent: one slicer project reads "Needs
 * slicing" to someone about to print it and "Slicer project" to someone
 * recording a print it already made.
 */
export type PrintFileClassificationSummary = Readonly<{
  status: WorkflowStatusKind;
  headline: string;
  nextStep: string;
  downloadOnly: boolean;
}>;

/** A classification summary plus whether the assignment may go ahead. */
export type PrintFileCheckSummary = PrintFileClassificationSummary &
  Readonly<{ assignable: boolean }>;

/**
 * What the operator is doing with this file.
 *
 * `print` means PrintPartner might still send these bytes to a printer, so
 * print-readiness decides whether the assignment may go ahead. `record` means
 * the print already happened, so the file is evidence of what was made rather
 * than instructions to run, and readability is all that decides. A project 3MF
 * is the ordinary case there: Bambu Studio and OrcaSlicer only write
 * Metadata/plate_N.gcode when you export a sliced file, so the project save an
 * operator keeps holds no toolpath, and it still carries the object names that
 * map to Required units.
 *
 * Required at both call sites rather than defaulted, so neither can drift into
 * the other's rules by saying nothing.
 */
export type PrintFileIntent = "print" | "record";

/** A name that says its own format, unlike a 3MF, which says nothing. */
const GCODE_EXTENSION = /\.(?:gcode|gco|bgcode)$/i;

/** What the record path adds to whatever the file turns out to be. */
const KEPT_AS_THE_RECORD = "PrintPartner keeps it as the record of this print.";

const UNREAD_HEADLINE = "Not read by PrintPartner";

/**
 * What to show the operator for a whole check, read or unread.
 *
 * A file PrintPartner read may go ahead on the record path whatever its
 * classification, because there is nothing left for it to be ready for. On the
 * print path only a file a printer can run may go ahead.
 */
export function printFileCheckSummary({
  preview,
  filename,
  intent,
}: {
  preview: PrintFileAssignmentPreview;
  filename: string;
  intent: PrintFileIntent;
}): PrintFileCheckSummary {
  if (!preview.inspected) return unreadSummary(intent, filename);
  return {
    ...printFileClassificationSummary(preview.classification, intent),
    assignable: readFileMayGoAhead(intent, preview.print_ready),
  };
}

function readFileMayGoAhead(intent: PrintFileIntent, printReady: boolean): boolean {
  switch (intent) {
    case "print":
      return printReady;
    case "record":
      return true;
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

/**
 * What to show for a file PrintPartner never read.
 *
 * There is no classification, so the name is the only thing known. A G-code
 * extension names its own format, so the assignment still earns the durable
 * manual record an unmonitored printer needs. A 3MF names nothing, and the
 * server refuses it under either intent, because the container may hold no
 * toolpaths and no object names either.
 */
function unreadSummary(intent: PrintFileIntent, filename: string): PrintFileCheckSummary {
  const unread = (nextStep: string, assignable: boolean): PrintFileCheckSummary => ({
    // PrintPartner never held the bytes, so nothing it writes can be checked
    // against them later. That is worth flagging under either intent.
    status: "needs_attention",
    headline: UNREAD_HEADLINE,
    nextStep,
    downloadOnly: false,
    assignable,
  });
  const namesItsFormat = GCODE_EXTENSION.test(filename);
  switch (intent) {
    case "print":
      return namesItsFormat
        ? unread(
            "PrintPartner could not read this file's bytes, so it goes on the record by name only. Mark it finished by hand when the print is done.",
            true,
          )
        : unread(
            "PrintPartner has to read a 3MF before it will track it, because the container may hold no printable toolpaths. Pick the file from the printer's own storage so the server can read it.",
            false,
          );
    case "record":
      return namesItsFormat
        ? unread(
            "PrintPartner could not read this file's bytes, so the record carries its name and nothing more.",
            true,
          )
        : unread(
            "PrintPartner has to read a 3MF before it will put it on the record, because the container may hold no object names to attribute. Upload the file so PrintPartner can read it.",
            false,
          );
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

export function printFileClassificationSummary(
  classification: PrintFileClassification,
  intent: PrintFileIntent,
): PrintFileClassificationSummary {
  switch (classification.format) {
    case "gcode":
      return intentSummary(intent, {
        print: {
          status: "ready",
          headline: "Sliced G-code",
          nextStep: "Ready to assign to a Build.",
          downloadOnly: false,
        },
        record: { headline: "Sliced G-code", fact: "This file is sliced G-code." },
      });
    case "bgcode":
      return intentSummary(intent, {
        print: {
          status: "ready",
          headline: "Sliced binary G-code",
          nextStep: "Ready to assign to a Build.",
          downloadOnly: false,
        },
        record: {
          headline: "Sliced binary G-code",
          fact: "This file is sliced binary G-code.",
        },
      });
    case "3mf":
      return threeMfSummary(classification.kind, intent);
    default: {
      const _exhaustive: never = classification;
      return _exhaustive;
    }
  }
}

function threeMfSummary(
  kind: Extract<PrintFileClassification, { format: "3mf" }>["kind"],
  intent: PrintFileIntent,
): PrintFileClassificationSummary {
  switch (kind) {
    case "slicer_project": {
      const fact = "This 3MF holds models and slicer settings.";
      return intentSummary(intent, {
        print: {
          status: "needs_attention",
          headline: "Needs slicing",
          nextStep: `${fact} Slice it in your slicer, then bring the G-code back here.`,
          downloadOnly: false,
        },
        record: { headline: "Slicer project", fact },
      });
    }
    case "model_package": {
      const fact = "This 3MF holds geometry with no slicer settings.";
      return intentSummary(intent, {
        print: {
          status: "needs_attention",
          headline: "Needs preparation and slicing",
          nextStep: `${fact} Add it to a Build as a Source, plan it, then slice the plate.`,
          downloadOnly: false,
        },
        record: { headline: "Model package", fact },
      });
    }
    case "toolpath_package": {
      const fact = "This 3MF holds toolpaths.";
      return intentSummary(intent, {
        print: {
          status: "needs_attention",
          headline: "Compatibility review required",
          nextStep: `${fact} Check it against this printer before you rely on it to print.`,
          downloadOnly: false,
        },
        record: { headline: "Sliced 3MF", fact },
      });
    }
    case "unsupported":
      return intentSummary(intent, {
        print: {
          status: "error",
          headline: "Unsupported 3MF",
          nextStep:
            "PrintPartner cannot read this container safely. Download it and open it in your slicer.",
          downloadOnly: true,
        },
        // PrintPartner read the container and could not make sense of what is
        // inside it. That is not a problem for a print that already happened,
        // so the record says what it knows and keeps the bytes.
        record: {
          headline: "Unrecognized 3MF",
          fact: "The contents of this 3MF are not in a form PrintPartner recognizes.",
        },
      });
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Pick one classification's words for the intent in hand.
 *
 * The print path owns its whole copy, because it is telling the operator what
 * has to happen before a printer can run these bytes. The record path shares
 * the fact about the file and adds the one sentence that is true of every file
 * it accepts, so no classification is told to go and slice something the
 * operator has already printed.
 */
function intentSummary(
  intent: PrintFileIntent,
  copy: Readonly<{
    print: PrintFileClassificationSummary;
    record: Readonly<{ headline: string; fact: string }>;
  }>,
): PrintFileClassificationSummary {
  switch (intent) {
    case "print":
      return copy.print;
    case "record":
      return {
        // Nothing the record path accepts is a problem there, so no
        // classification wears a warning. The badge carries its own words and
        // its own icon shape, so the tone is never what says this is fine.
        status: "ready",
        headline: copy.record.headline,
        nextStep: `${copy.record.fact} ${KEPT_AS_THE_RECORD}`,
        // The record keeps every file it accepts, so nothing is handed back
        // untracked.
        downloadOnly: false,
      };
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

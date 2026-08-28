import type { PrintFileClassification } from "@print-partner/contracts";
import type { PrintFileAssignmentPreview } from "../../api/endpoints/checkoff";
import type { WorkflowStatusKind } from "@/lib/statusTone";

/**
 * The classification in the operator's language.
 *
 * `headline` is the words the research doc fixed for each classification, so a
 * project 3MF never reads as something that can be printed. `nextStep` says who
 * has to do what. `downloadOnly` marks the one classification PrintPartner will
 * hand back but not track as a print.
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

const PRINT_READY_EXTENSION = /\.(?:gcode|gco|bgcode)$/i;

/**
 * What to show the operator for a whole check, read or unread.
 *
 * A file PrintPartner never read has no classification, so it gets its own copy
 * rather than a guessed one. A 3MF is the one case where not reading the bytes
 * blocks the assignment outright: the container may hold nothing printable, and
 * the server refuses it. G-code names its own format, so an unread upload still
 * earns the durable manual-transfer record an unmonitored printer needs.
 */
export function printFileCheckSummary({
  preview,
  filename,
}: {
  preview: PrintFileAssignmentPreview;
  filename: string;
}): PrintFileCheckSummary {
  if (preview.inspected) {
    const summary = printFileClassificationSummary(preview.classification);
    return { ...summary, assignable: preview.print_ready };
  }
  return PRINT_READY_EXTENSION.test(filename)
    ? {
        status: "needs_attention",
        headline: "Not read by PrintPartner",
        nextStep:
          "PrintPartner could not read this file's bytes, so it goes on the record by name only. Mark it finished by hand when the print is done.",
        downloadOnly: false,
        assignable: true,
      }
    : {
        status: "needs_attention",
        headline: "Not read by PrintPartner",
        nextStep:
          "PrintPartner has to read a 3MF before it will track it, because the container may hold no printable toolpaths. Pick the file from the printer's own storage so the server can read it.",
        downloadOnly: false,
        assignable: false,
      };
}

export function printFileClassificationSummary(
  classification: PrintFileClassification,
): PrintFileClassificationSummary {
  switch (classification.format) {
    case "gcode":
      return {
        status: "ready",
        headline: "Sliced G-code",
        nextStep: "Ready to assign to a Build.",
        downloadOnly: false,
      };
    case "bgcode":
      return {
        status: "ready",
        headline: "Sliced binary G-code",
        nextStep: "Ready to assign to a Build.",
        downloadOnly: false,
      };
    case "3mf":
      return threeMfSummary(classification.kind);
    default: {
      const _exhaustive: never = classification;
      return _exhaustive;
    }
  }
}

function threeMfSummary(
  kind: Extract<PrintFileClassification, { format: "3mf" }>["kind"],
): PrintFileClassificationSummary {
  switch (kind) {
    case "slicer_project":
      return {
        status: "needs_attention",
        headline: "Needs slicing",
        nextStep:
          "This 3MF holds models and slicer settings. Slice it in your slicer, then bring the G-code back here.",
        downloadOnly: false,
      };
    case "model_package":
      return {
        status: "needs_attention",
        headline: "Needs preparation and slicing",
        nextStep:
          "This 3MF holds geometry with no slicer settings. Add it to a Build as a Source, plan it, then slice the plate.",
        downloadOnly: false,
      };
    case "toolpath_package":
      return {
        status: "needs_attention",
        headline: "Compatibility review required",
        nextStep:
          "This 3MF holds toolpaths. Check it against this printer before you rely on it to print.",
        downloadOnly: false,
      };
    case "unsupported":
      return {
        status: "error",
        headline: "Unsupported 3MF",
        nextStep:
          "PrintPartner cannot read this container safely. Download it and open it in your slicer.",
        downloadOnly: true,
      };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

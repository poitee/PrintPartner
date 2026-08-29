import { describe, expect, it } from "vitest";
import { isPrintReady, type PrintFileClassification } from "@print-partner/contracts";
import type { PrintFileAssignmentPreview } from "../../api/endpoints/checkoff";
import {
  printFileCheckSummary,
  printFileClassificationSummary,
} from "./printFileClassification";

const CLASSIFICATIONS: readonly PrintFileClassification[] = [
  { format: "gcode" },
  { format: "bgcode" },
  { format: "3mf", kind: "slicer_project" },
  { format: "3mf", kind: "model_package" },
  { format: "3mf", kind: "toolpath_package" },
  { format: "3mf", kind: "unsupported" },
];

describe("printFileClassificationSummary, print intent", () => {
  it("shows a sliced file as ready", () => {
    expect(printFileClassificationSummary({ format: "gcode" }, "print")).toMatchObject({
      status: "ready",
      headline: "Sliced G-code",
      downloadOnly: false,
    });
    expect(printFileClassificationSummary({ format: "bgcode" }, "print").status).toBe("ready");
  });

  it("shows a sliced 3MF as ready to assign, not as a review gate", () => {
    expect(printFileClassificationSummary(
      { format: "3mf", kind: "toolpath_package" },
      "print",
    )).toMatchObject({
      status: "ready",
      headline: "Sliced 3MF",
      downloadOnly: false,
    });
    expect(isPrintReady({ format: "3mf", kind: "toolpath_package" })).toBe(true);
  });

  it("names each 3MF classification", () => {
    const cases: readonly { classification: PrintFileClassification; headline: string }[] = [
      { classification: { format: "3mf", kind: "slicer_project" }, headline: "Needs slicing" },
      {
        classification: { format: "3mf", kind: "model_package" },
        headline: "Needs preparation and slicing",
      },
      {
        classification: { format: "3mf", kind: "toolpath_package" },
        headline: "Sliced 3MF",
      },
      { classification: { format: "3mf", kind: "unsupported" }, headline: "Unsupported 3MF" },
    ];
    for (const { classification, headline } of cases) {
      expect(printFileClassificationSummary(classification, "print").headline).toBe(headline);
    }
  });

  it("offers download, not printing, for a container it cannot read", () => {
    const unsupported = printFileClassificationSummary(
      { format: "3mf", kind: "unsupported" },
      "print",
    );
    expect(unsupported.downloadOnly).toBe(true);
    expect(unsupported.status).toBe("error");
    expect(isPrintReady({ format: "3mf", kind: "unsupported" })).toBe(false);
  });

  it("never presents an unsliced 3MF as something to print", () => {
    for (const kind of ["slicer_project", "model_package"] as const) {
      expect(printFileClassificationSummary({ format: "3mf", kind }, "print")).toMatchObject({
        status: "needs_attention",
        downloadOnly: false,
      });
      expect(isPrintReady({ format: "3mf", kind })).toBe(false);
    }
  });

  it("tells the operator what to do next in every case", () => {
    for (const classification of CLASSIFICATIONS) {
      expect(
        printFileClassificationSummary(classification, "print").nextStep.length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("printFileClassificationSummary, record intent", () => {
  it("names the file and says it is being kept, whatever the classification", () => {
    for (const classification of CLASSIFICATIONS) {
      const summary = printFileClassificationSummary(classification, "record");
      expect(summary.headline.length).toBeGreaterThan(0);
      expect(summary.nextStep).toContain("PrintPartner keeps it as the record of this print.");
      // Nothing the record path accepts is a problem there.
      expect(summary.status).toBe("ready");
      expect(summary.downloadOnly).toBe(false);
    }
  });

  it("never tells the operator to slice or prepare a print they already made", () => {
    for (const classification of CLASSIFICATIONS) {
      const { headline, nextStep } = printFileClassificationSummary(classification, "record");
      // "Sliced G-code" is a name, not an instruction. These are instructions.
      const advice = [
        /needs slicing/i,
        /slice it/i,
        /slice the plate/i,
        /needs preparation/i,
        /download it/i,
        /unsupported/i,
      ];
      for (const scolding of advice) {
        expect(`${headline} ${nextStep}`).not.toMatch(scolding);
      }
    }
  });

  it("calls a slicer project what it is, and keeps the fact the print path states", () => {
    const project = printFileClassificationSummary(
      { format: "3mf", kind: "slicer_project" },
      "record",
    );
    expect(project.headline).toBe("Slicer project");
    expect(project.nextStep).toContain("This 3MF holds models and slicer settings.");
  });

  it("is honest about a container it read but cannot interpret", () => {
    const unsupported = printFileClassificationSummary(
      { format: "3mf", kind: "unsupported" },
      "record",
    );
    expect(unsupported.headline).toBe("Unrecognized 3MF");
    expect(unsupported.nextStep).toContain("not in a form PrintPartner recognizes");
  });
});

describe("printFileCheckSummary", () => {
  /** A check the server answered from the bytes, as the route builds it. */
  function readPreview(classification: PrintFileClassification): PrintFileAssignmentPreview {
    return {
      inspected: true,
      classification,
      print_ready: isPrintReady(classification),
      suggested_units: [],
      suggestion_basis: "none",
      unlabeled_names: [],
      plan_revision_id: 4,
    };
  }

  /** A check for a file PrintPartner never got the bytes of. */
  function unreadPreview(): PrintFileAssignmentPreview {
    return {
      inspected: false,
      suggested_units: [],
      suggestion_basis: "none",
      unlabeled_names: [],
      plan_revision_id: 4,
    };
  }

  it("lets print-readiness decide the print path", () => {
    for (const classification of CLASSIFICATIONS) {
      const printReady = isPrintReady(classification);
      expect(
        printFileCheckSummary({
          preview: readPreview(classification),
          filename: "part.3mf",
          intent: "print",
        }).assignable,
      ).toBe(printReady);
    }
  });

  it("records any file it read, including the project 3MF a printer cannot run", () => {
    for (const classification of CLASSIFICATIONS) {
      expect(
        printFileCheckSummary({
          preview: readPreview(classification),
          filename: "part.3mf",
          intent: "record",
        }).assignable,
      ).toBe(true);
    }
  });

  it("refuses an unread 3MF under either intent, because the server does", () => {
    for (const intent of ["print", "record"] as const) {
      const summary = printFileCheckSummary({
        preview: unreadPreview(),
        filename: "chassis.3mf",
        intent,
      });
      expect(summary.assignable).toBe(false);
      expect(summary.headline).toBe("Not read by PrintPartner");
    }
  });

  it("keeps an unread G-code assignable, so a manual transfer still leaves a record", () => {
    for (const intent of ["print", "record"] as const) {
      expect(
        printFileCheckSummary({
          preview: unreadPreview(),
          filename: "bracket.bgcode",
          intent,
        }).assignable,
      ).toBe(true);
    }
  });

  it("does not tell the record path to finish a print that is already finished", () => {
    const record = printFileCheckSummary({
      preview: unreadPreview(),
      filename: "bracket.gcode",
      intent: "record",
    });
    expect(record.nextStep).toContain("the record carries its name and nothing more");
    expect(record.nextStep).not.toMatch(/mark it finished/i);
  });
});

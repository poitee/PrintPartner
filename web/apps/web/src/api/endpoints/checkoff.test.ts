import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  assignUploadedPrinterFile,
  parsePrintFileAssignmentPreview,
  uploadPrintFileForAssignment,
} from "./checkoff";

const BASIS = {
  suggested_units: [
    { part_id: 1, unit_index: 0, object_name: "bracket_left.stl" },
    { part_id: 2, unit_index: 0 },
  ],
  suggestion_basis: "object_names",
  unlabeled_names: ["mystery.stl"],
  plan_revision_id: 4,
};

const INSPECTED = {
  ...BASIS,
  inspected: true,
  classification: { format: "3mf", kind: "slicer_project" },
  print_ready: false,
};

const UNREADABLE = /shape this app cannot read/;

describe("parsePrintFileAssignmentPreview", () => {
  it("validates the plan review before offering manual choices", () => {
    const match_review = { objects: [{ object_index: 0, name: "part.stl" }], parts: [
      { part_id: 1, filename: "part.stl", relative_path: "source/part.stl", units: [{ part_id: 1, unit_index: 0 }] },
    ] };
    expect(parsePrintFileAssignmentPreview({ ...INSPECTED, match_review }).match_review).toEqual(match_review);
    expect(() => parsePrintFileAssignmentPreview({ ...INSPECTED, match_review: {
      ...match_review, objects: [...match_review.objects, ...match_review.objects],
    } })).toThrow(UNREADABLE);
    expect(() => parsePrintFileAssignmentPreview({ ...INSPECTED, match_review: {
      ...match_review, parts: [{ ...match_review.parts[0], units: [{ part_id: 99, unit_index: 0 }] }],
    } })).toThrow(UNREADABLE);
  });
  it("reads a check that read the bytes", () => {
    expect(parsePrintFileAssignmentPreview(INSPECTED)).toEqual({
      inspected: true,
      classification: { format: "3mf", kind: "slicer_project" },
      print_ready: false,
      suggested_units: [
        { part_id: 1, unit_index: 0, object_name: "bracket_left.stl" },
        { part_id: 2, unit_index: 0 },
      ],
      suggestion_basis: "object_names",
      unlabeled_names: ["mystery.stl"],
      plan_revision_id: 4,
    });
  });

  it("reads a check that never read the bytes, and gives it no classification", () => {
    const preview = parsePrintFileAssignmentPreview({ ...BASIS, inspected: false });
    expect(preview.inspected).toBe(false);
    expect(preview).not.toHaveProperty("classification");
    expect(preview).not.toHaveProperty("print_ready");
    expect(preview.plan_revision_id).toBe(4);
  });

  it("reads a sliced classification with no kind", () => {
    const preview = parsePrintFileAssignmentPreview({
      ...INSPECTED,
      classification: { format: "gcode" },
    });
    expect(preview.inspected && preview.classification).toEqual({ format: "gcode" });
  });

  it("drops a field the UI does not use rather than failing", () => {
    expect(
      parsePrintFileAssignmentPreview({ ...INSPECTED, next_action: "slice it" }),
    ).not.toHaveProperty("next_action");
  });

  it("refuses to blur the two arms together", () => {
    // Read, but with nothing to show for it.
    const { classification: _c, ...noClassification } = INSPECTED;
    expect(() => parsePrintFileAssignmentPreview(noClassification)).toThrow(UNREADABLE);
    const { print_ready: _p, ...noReadiness } = INSPECTED;
    expect(() => parsePrintFileAssignmentPreview(noReadiness)).toThrow(UNREADABLE);
    // Never read, yet claiming to know.
    expect(() =>
      parsePrintFileAssignmentPreview({
        ...BASIS,
        inspected: false,
        classification: { format: "gcode" },
      }),
    ).toThrow(UNREADABLE);
    // Not a discriminant at all.
    expect(() => parsePrintFileAssignmentPreview({ ...BASIS, inspected: "maybe" })).toThrow(
      UNREADABLE,
    );
    expect(() => parsePrintFileAssignmentPreview(BASIS)).toThrow(UNREADABLE);
  });

  it("rejects a classification this app cannot branch on", () => {
    for (const classification of [
      null,
      {},
      { format: "step" },
      { format: "3mf" },
      { format: "3mf", kind: "mystery" },
    ]) {
      expect(() => parsePrintFileAssignmentPreview({ ...INSPECTED, classification })).toThrow(
        UNREADABLE,
      );
    }
  });

  it("rejects a classification nested where the UI does not look for it", () => {
    expect(() =>
      parsePrintFileAssignmentPreview({
        ...BASIS,
        inspected: true,
        file: { classification: { format: "gcode" }, print_ready: true },
      }),
    ).toThrow(UNREADABLE);
  });

  it("rejects a suggestion basis it has no words for", () => {
    expect(() =>
      parsePrintFileAssignmentPreview({ ...INSPECTED, suggestion_basis: "vibes" }),
    ).toThrow(UNREADABLE);
  });

  it("rejects a unit that is not a Required unit coordinate", () => {
    for (const suggested of [
      "units",
      [null],
      [{ part_id: 1 }],
      [{ part_id: "1", unit_index: 0 }],
      [{ part_id: 1.5, unit_index: 0 }],
    ]) {
      expect(() =>
        parsePrintFileAssignmentPreview({ ...INSPECTED, suggested_units: suggested }),
      ).toThrow(UNREADABLE);
    }
  });

  it("rejects a reply that is not an object at all", () => {
    for (const value of [null, undefined, "ok", 7, []]) {
      expect(() => parsePrintFileAssignmentPreview(value)).toThrow(UNREADABLE);
    }
  });
});

describe("uploaded print files", () => {
  const http = createEndpointTestHttp();

  const READY = {
    ...BASIS,
    inspected: true,
    classification: { format: "bgcode" },
    print_ready: true,
    next_action: "Ready to assign to a Build.",
  };

  it("posts the bytes with the Build and the labels this browser read", async () => {
    http.respond(jsonResponse({ ...READY, upload_token: "upload-one" }));

    const check = await uploadPrintFileForAssignment({
      profile_id: 7,
      file: new File(["binary"], "bracket.bgcode"),
      object_names: ["bracket_left.stl"],
    });

    expect(check.upload_token).toBe("upload-one");
    expect(check.inspected && check.classification).toEqual({ format: "bgcode" });
    expect(check.plan_revision_id).toBe(4);

    const request = http.request(0);
    expect(request.url).toBe("/printer-checkoff/file-assignments/upload");
    expect(request.method).toBe("POST");
    const form = http.requestForm(0);
    expect(form.get("profile_id")).toBe("7");
    expect(form.get("object_names")).toBe(JSON.stringify(["bracket_left.stl"]));
    const sent = form.get("file");
    expect(sent instanceof File && sent.name).toBe("bracket.bgcode");
  });

  it("refuses a stored upload the server did not name", async () => {
    http.respond(jsonResponse(READY));

    await expect(
      uploadPrintFileForAssignment({
        profile_id: 7,
        file: new File(["binary"], "bracket.bgcode"),
        object_names: [],
      }),
    ).rejects.toThrow(/did not name it/);
  });

  it("assigns an upload by its token instead of a printer path", async () => {
    http.respond(jsonResponse({ link: { id: "link-one", filename: "bracket.bgcode", units: [] } }));

    await assignUploadedPrinterFile({
      profile_id: 7,
      printer_id: "sd-card-printer",
      filename: "bracket.bgcode",
      upload_token: "upload-one",
      object_names: ["bracket_left.stl"],
      tracking: "manual",
      completed: true,
      plan_revision_id: 4,
      unit_tokens: ["1:0"],
    });

    expect(http.request(0).url).toBe("/printer-checkoff/file-assignments");
    expect(http.requestJson(0)).toEqual({
      profile_id: 7,
      printer_id: "sd-card-printer",
      filename: "bracket.bgcode",
      upload_token: "upload-one",
      object_names: ["bracket_left.stl"],
      tracking: "manual",
      completed: true,
      plan_revision_id: 4,
      unit_tokens: ["1:0"],
    });
  });
});

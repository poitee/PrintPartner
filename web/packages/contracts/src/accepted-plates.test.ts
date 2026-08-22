import { describe, expect, it } from "vitest";
import {
  parseAcceptedPlateEndpointError,
  parseAcceptedPlateExportJobList,
  parseAcceptedPlateWorkspace,
  parseAcceptedPlanBasis,
  parseArrangeAcceptedPlatesRequest,
  parseDirectExportJobResult,
  parseMoveAcceptedPlateUnitRequest,
  parsePinAcceptedPlateUnitRequest,
  parseRestoreAcceptedPlatesRequest,
  parseStartDirectExportRequest,
  parseTransferAcceptedPlateUnitRequest,
} from "./accepted-plates.js";
import { JOB_KINDS } from "./index.js";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const plateId = `plate_${"c".repeat(32)}`;

const basis = {
  profile_id: 7,
  plan_version: 3,
  plan_revision_id: 11,
  plan_revision_digest: digest,
  required_unit_mapping_digest: digest,
};

const printer = {
  id: "printer-one",
  name: "Printer One",
  model: "Model One",
  bed_width_um: 250_000,
  bed_depth_um: 210_000,
  bed_height_um: 200_000,
  margin_um: 4_000,
};

const setupUnit = {
  token,
  object_name: `bracket__${token}`,
  filename: "bracket.stl",
  source_layer: "Hardware",
  role: "primary",
  filament_color_id: null,
};

describe("accepted Plate contracts", () => {
  it("parses only a complete immutable accepted Plan basis", () => {
    expect(parseAcceptedPlanBasis(basis)).toEqual(basis);
    expect(() => parseAcceptedPlanBasis({ ...basis, plan_revision_digest: "bad" })).toThrow();
    expect(() => parseAcceptedPlanBasis({ ...basis, private_path: "/secret" })).toThrow();
  });

  it("defines every startable job kind", () => {
    expect(JOB_KINDS).toEqual([
      "sync",
      "import-scan",
      "extract-source-docs",
      "check-source-updates",
      "export-stl-pack",
      "export-checklist-html",
      "export-kit-bundle",
      "export-accepted-plate-3mf",
      "export-direct-3mf",
      "printer-upload",
    ]);
  });

  it("defaults Required-unit completion to incomplete and keeps explicit completed flags", () => {
    expect(parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [setupUnit],
    })).toMatchObject({ kind: "setup", units: [{ token, completed: false }] });

    expect(parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [{ ...setupUnit, completed: true }],
    })).toMatchObject({ kind: "setup", units: [{ token, completed: true }] });
  });

  it("parses strict setup and ready workspace variants", () => {
    expect(parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [setupUnit],
    })).toMatchObject({ kind: "setup", units: [{ token }] });

    expect(parseAcceptedPlateWorkspace({
      kind: "ready",
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      printers: [printer],
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        printer,
        units: [{
          ...setupUnit,
          x_um: 4_000,
          y_um: 5_000,
          width_um: 30_000,
          depth_um: 20_000,
          height_um: 10_000,
        }],
      }],
    })).toMatchObject({
      kind: "ready",
      plates: [{
        plate_id: plateId,
        units: [{ placement: "auto", pinned: false }],
      }],
      arrange_undo_revision_id: null,
      unplaced: [],
    });
  });

  it("models pin provenance independently from automatic or manual placement", () => {
    const manualPinned = {
      ...setupUnit,
      x_um: 4_000,
      y_um: 5_000,
      width_um: 30_000,
      depth_um: 20_000,
      height_um: 10_000,
      placement: "manual",
      pinned: true,
    };
    const workspace = parseAcceptedPlateWorkspace({
      kind: "ready",
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      printers: [printer],
      plates: [{ plate_id: plateId, ordinal: 1, printer, units: [manualPinned] }],
    });
    if (workspace.kind !== "ready") throw new Error("ready workspace was not parsed");
    expect(workspace).toMatchObject({
      kind: "ready",
      plates: [{ units: [{ placement: "manual", pinned: true }] }],
    });
    expect(() => parseAcceptedPlateWorkspace({
      ...workspace,
      plates: [{
        ...workspace.plates[0],
        units: [{ ...manualPinned, placement: "pinned" }],
      }],
    })).toThrow();
  });

  it("parses edit commands and enforces a strict transfer target union", () => {
    expect(parsePinAcceptedPlateUnitRequest({
      expected: basis,
      expected_plate_revision_id: 19,
      pinned: true,
    })).toMatchObject({ pinned: true });
    expect(parseArrangeAcceptedPlatesRequest({
      expected: basis,
      expected_plate_revision_id: 19,
      mode: "all",
    })).toMatchObject({ mode: "all" });
    expect(parseRestoreAcceptedPlatesRequest({
      expected: basis,
      expected_plate_revision_id: 22,
      restore_plate_revision_id: 19,
    })).toMatchObject({ restore_plate_revision_id: 19 });
    expect(parseTransferAcceptedPlateUnitRequest({
      expected: basis,
      expected_plate_revision_id: 19,
      target_plate_id: plateId,
    })).toMatchObject({ target_plate_id: plateId });
    expect(parseTransferAcceptedPlateUnitRequest({
      expected: basis,
      expected_plate_revision_id: 19,
      target_printer_id: "printer-mk4",
    })).toMatchObject({ target_printer_id: "printer-mk4" });
    expect(() => parseTransferAcceptedPlateUnitRequest({
      expected: basis,
      expected_plate_revision_id: 19,
    })).toThrow();
    expect(() => parseTransferAcceptedPlateUnitRequest({
      expected: basis,
      expected_plate_revision_id: 19,
      target_plate_id: plateId,
      target_printer_id: "printer-mk4",
    })).toThrow();
  });

  it("rejects unknown fields, duplicate tokens, noncontiguous ordinals, and units outside printable bounds", () => {
    expect(() => parseAcceptedPlateWorkspace({ kind: "empty_plan", extra: true })).toThrow();
    const placed = {
      ...setupUnit,
      x_um: 4_000,
      y_um: 4_000,
      width_um: 30_000,
      depth_um: 20_000,
      height_um: 10_000,
    };
    const ready = {
      kind: "ready",
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      printers: [printer],
      plates: [
        { plate_id: plateId, ordinal: 1, printer, units: [placed] },
        { plate_id: `plate_${"d".repeat(32)}`, ordinal: 3, printer, units: [placed] },
      ],
    };
    expect(() => parseAcceptedPlateWorkspace(ready)).toThrow();
    expect(() => parseAcceptedPlateWorkspace({
      ...ready,
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        printer,
        units: [{ ...placed, x_um: 230_000 }],
      }],
    })).toThrow();
    expect(() => parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [setupUnit, setupUnit],
    })).toThrow();
    expect(() => parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer, { ...printer, name: "Duplicate identity" }],
      units: [setupUnit],
    })).toThrow();
  });

  it("rejects unsafe integers, malformed digests and non-integer micrometres", () => {
    expect(() => parseMoveAcceptedPlateUnitRequest({
      expected: { ...basis, profile_id: Number.MAX_SAFE_INTEGER + 1 },
      expected_plate_revision_id: 19,
      x_um: 1,
      y_um: 2,
    })).toThrow();
    expect(() => parseMoveAcceptedPlateUnitRequest({
      expected: { ...basis, plan_revision_digest: digest.toUpperCase() },
      expected_plate_revision_id: 19,
      x_um: 1.5,
      y_um: 2,
    })).toThrow();
  });

  it("pins endpoint error codes to statuses and drops unapproved fields", () => {
    expect(parseAcceptedPlateEndpointError({
      code: "plate_revision_changed",
      detail: "/private/customer/path",
      stack: "secret stack",
    }, 409)).toEqual({ code: "plate_revision_changed" });
    expect(() => parseAcceptedPlateEndpointError({ code: "plate_revision_changed" }, 422)).toThrow();
    expect(parseAcceptedPlateEndpointError({ code: "unplaced_units" }, 409)).toEqual({
      code: "unplaced_units",
    });
    expect(parseAcceptedPlateEndpointError({
      code: "unit_too_large",
      token,
      printer_id: "printer-one",
      digest,
    }, 422)).toEqual({ code: "unit_too_large", token, printer_id: "printer-one" });
    expect(parseAcceptedPlateEndpointError({ code: "unit_not_found" }, 422)).toEqual({
      code: "unit_not_found",
    });
  });

  it("filters accepted export history and rejects completed results from another Build", () => {
    const result = {
      format: "accepted-plate-export-job-v1",
      profile_id: 7,
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      layout_digest: digest,
      download_url: "/exports/accepted/revision-19/bundle.zip",
      manifest_download_url: "/exports/accepted/revision-19/manifest.json",
      bundle_download_url: "/exports/accepted/revision-19/bundle.zip",
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        filename: "plate-0001.3mf",
        download_url: "/exports/accepted/revision-19/plate-0001.3mf",
      }],
    };
    const jobs = parseAcceptedPlateExportJobList({ jobs: [
      {
        job_id: "job-one",
        kind: "export-accepted-plate-3mf",
        status: "done",
        message: "Done",
        progress: 1,
        result,
        error: null,
        updated_at: "2026-08-21T12:00:00.000Z",
      },
      {
        job_id: "job-two",
        kind: "export-3mf",
        status: "done",
        message: "Done",
        progress: 1,
        result: null,
        error: null,
      },
    ] }, 7);
    expect(jobs).toEqual([expect.objectContaining({ job_id: "job-one", result })]);
    expect(() => parseAcceptedPlateExportJobList({ jobs: [{
      job_id: "job-one",
      kind: "export-accepted-plate-3mf",
      status: "done",
      message: "Done",
      progress: 1,
      result: { ...result, profile_id: 8 },
      error: null,
    }] }, 7)).toThrow();
  });

  it("parses a Direct export start request and job result", () => {
    expect(parseStartDirectExportRequest({
      profile_id: 7,
      tokens: [token],
    })).toEqual({ profile_id: 7, tokens: [token] });
    expect(() => parseStartDirectExportRequest({ profile_id: 7, tokens: [] })).toThrow();
    expect(parseDirectExportJobResult({
      format: "direct-export-3mf-job-v1",
      profile_id: 7,
      basis,
      download_url: "/exports/direct.3mf",
      filename: "direct-abcd.3mf",
      tokens: [token],
    })).toMatchObject({ profile_id: 7, tokens: [token] });
  });
});

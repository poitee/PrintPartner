import { describe, expect, it } from "vitest";
import type {
  AcceptedPlateExportRecord,
  AcceptedPlateWorkspace,
  RequiredUnitToken,
} from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../api/endpoints/checkoff";
import {
  currentExportArtifact,
  projectWorkPackages,
  requiredUnitTokensFromObjectNames,
  workPackageStatusOwner,
  type WorkPackageProjectionInput,
} from "./workPackageProjection";

function token(seed: string): RequiredUnitToken {
  return `ppu_${seed.repeat(32).slice(0, 32)}` as RequiredUnitToken;
}

const TOKEN_A = token("a");
const TOKEN_B = token("b");

const basis = {
  profile_id: 1,
  plan_version: 4,
  plan_revision_id: 12,
  plan_revision_digest: "0".repeat(64),
  required_unit_mapping_digest: "1".repeat(64),
};

const printer = {
  id: "printer-1",
  name: "Voron",
  model: "2.4",
  bed_width_um: 350_000,
  bed_depth_um: 350_000,
  bed_height_um: 350_000,
  margin_um: 5_000,
};

function placedUnit(unitToken: RequiredUnitToken, completed = false) {
  return {
    token: unitToken,
    object_name: `part__${unitToken}`,
    filename: "part.stl",
    relative_path: "",
    source_directory: "",
    source_layer: "kit",
    role: "frame",
    filament_color_id: null,
    completed,
    x_um: 10_000,
    y_um: 10_000,
    width_um: 20_000,
    depth_um: 20_000,
    height_um: 20_000,
    placement: "auto" as const,
    pinned: false,
  };
}

function readyWorkspace(overrides: Partial<Extract<AcceptedPlateWorkspace, { kind: "ready" }>> = {}) {
  const workspace: Extract<AcceptedPlateWorkspace, { kind: "ready" }> = {
    kind: "ready",
    basis,
    plate_revision_id: 90,
    plate_revision_number: 3,
    arrange_undo_revision_id: null,
    printers: [printer],
    plates: [
      { plate_id: "plate_1", ordinal: 1, printer, units: [placedUnit(TOKEN_A), placedUnit(TOKEN_B)] },
    ],
    unplaced: [],
    unassigned: [],
    ...overrides,
  } as Extract<AcceptedPlateWorkspace, { kind: "ready" }>;
  return workspace;
}

function input(overrides: Partial<WorkPackageProjectionInput> = {}): WorkPackageProjectionInput {
  return {
    profileId: 1,
    workspace: readyWorkspace(),
    setup: undefined,
    selectedTokens: [TOKEN_A, TOKEN_B],
    exportRecords: [],
    checkoffLinks: [],
    slicedFile: null,
    printer: null,
    ...overrides,
  };
}

function exportRecord(plateRevisionId: number): AcceptedPlateExportRecord {
  return {
    job_id: `job-${plateRevisionId}`,
    kind: "export-accepted-plate-3mf",
    status: "done",
    message: "done",
    progress: 1,
    error: null,
    result: {
      format: "accepted-plate-export-job-v1",
      profile_id: 1,
      basis,
      plate_revision_id: plateRevisionId,
      plate_revision_number: 3,
      layout_digest: "2".repeat(64),
      download_url: "/exports/a.3mf",
      manifest_download_url: "/exports/a.json",
      bundle_download_url: "/exports/a.zip",
      plates: [{ plate_id: "plate_1", ordinal: 1, filename: "plate-1.3mf", download_url: "/exports/p1.3mf" }],
    },
  } as AcceptedPlateExportRecord;
}

function checkoffLink(overrides: Partial<PrinterCheckoffLink> = {}): PrinterCheckoffLink {
  return {
    id: "link-1",
    profile_id: 1,
    integration_id: "int-1",
    printer_id: "printer-1",
    host_name: "Voron",
    filename: "batch.gcode",
    units: [{ part_id: 3, unit_index: 0, object_name: `part__${TOKEN_A}` }],
    state: "watching",
    saw_active: false,
    created_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("requiredUnitTokensFromObjectNames", () => {
  it("reads the Required-unit token out of an object name", () => {
    expect(requiredUnitTokensFromObjectNames([`bracket__${TOKEN_A}`])).toEqual([TOKEN_A]);
  });

  it("skips names with no token and removes duplicates", () => {
    expect(
      requiredUnitTokensFromObjectNames([`a__${TOKEN_A}`, "plain", undefined, `b__${TOKEN_A}`]),
    ).toEqual([TOKEN_A]);
  });
});

describe("currentExportArtifact", () => {
  it("returns nothing when no export matches the Plate revision", () => {
    expect(currentExportArtifact([exportRecord(11)], 90)).toBeNull();
  });

  it("returns the newest matching export", () => {
    const artifact = currentExportArtifact([exportRecord(90), exportRecord(90)], 90);
    expect(artifact?.plateCount).toBe(1);
    expect(artifact?.bundleUrl).toBe("/exports/a.zip");
  });
});

describe("projectWorkPackages bench status", () => {
  it("is Preparing when nothing is selected", () => {
    const { bench } = projectWorkPackages(input({ selectedTokens: [] }));
    expect(bench?.status).toBe("preparing");
    expect(bench?.summary).toContain("Choose the Required units");
  });

  it("is Preparing while units are still unassigned", () => {
    const workspace = readyWorkspace({
      unassigned: [
        {
          token: TOKEN_B,
          object_name: `part__${TOKEN_B}`,
          filename: "part.stl",
          relative_path: "",
          source_directory: "",
          source_layer: "kit",
          role: "frame",
          filament_color_id: null,
          completed: false,
        },
      ],
    });
    expect(projectWorkPackages(input({ workspace })).bench?.status).toBe("preparing");
  });

  it("is Ready to slice once the Plates are arranged and nothing is exported", () => {
    expect(projectWorkPackages(input()).bench?.status).toBe("ready_to_slice");
  });

  it("is Awaiting sliced file after a matching export", () => {
    const projection = projectWorkPackages(input({ exportRecords: [exportRecord(90)] }));
    expect(projection.bench?.status).toBe("awaiting_sliced_file");
    expect(projection.bench?.links.exportArtifact?.jobId).toBe("job-90");
  });

  it("is Ready to send once a sliced file is added", () => {
    const projection = projectWorkPackages(
      input({ exportRecords: [exportRecord(90)], slicedFile: { name: "batch.gcode" } }),
    );
    expect(projection.bench?.status).toBe("ready_to_send");
  });

  it("is Failed when the last export failed", () => {
    expect(projectWorkPackages(input({ exportFailed: true })).bench?.status).toBe("failed");
  });

  it("keeps the links that tie the package to its records", () => {
    const bench = projectWorkPackages(input({ exportRecords: [exportRecord(90)] })).bench;
    expect(bench?.links.acceptedPlan).toEqual({ revisionId: 12, version: 4 });
    expect(bench?.links.plateRevision).toEqual({ id: 90, number: 3 });
    expect(bench?.links.unitTokens).toEqual([TOKEN_A, TOKEN_B]);
    expect(bench?.id).toBe("bench-plate-90");
  });

  it("blocks the bench package when the Build has no Required units", () => {
    const { bench } = projectWorkPackages(input({ workspace: { kind: "empty_plan" } }));
    expect(bench?.blockedReason).toContain("Accept a Plan revision");
  });
});

describe("projectWorkPackages dispatched packages", () => {
  it("reports Queued before the printer starts and Printing after", () => {
    expect(projectWorkPackages(input({ checkoffLinks: [checkoffLink()] })).active[0]?.status)
      .toBe("queued");
    expect(
      projectWorkPackages(input({ checkoffLinks: [checkoffLink({ saw_active: true })] })).active[0]
        ?.status,
    ).toBe("printing");
  });

  it("reports Needs verification and Failed", () => {
    expect(
      projectWorkPackages(input({ checkoffLinks: [checkoffLink({ state: "awaiting_verify" })] }))
        .active[0]?.status,
    ).toBe("needs_verification");
    expect(
      projectWorkPackages(input({ checkoffLinks: [checkoffLink({ state: "host_failed" })] }))
        .active[0]?.status,
    ).toBe("failed");
  });

  it("moves verified packages to recent and keeps the Checkoff route", () => {
    const projection = projectWorkPackages(
      input({ checkoffLinks: [checkoffLink({ state: "verified", units_marked: 1 })] }),
    );
    expect(projection.active).toHaveLength(0);
    expect(projection.recent[0]?.status).toBe("complete");
    expect(projection.recent[0]?.links.verification?.route).toBe("/progress?profile=1");
  });

  it("carries the Required-unit tokens the sent file covers", () => {
    const projection = projectWorkPackages(input({ checkoffLinks: [checkoffLink()] }));
    expect(projection.active[0]?.links.unitTokens).toEqual([TOKEN_A]);
    expect(projection.active[0]?.links.sendJob?.linkId).toBe("link-1");
  });

  it("ignores dismissed links and links from another Build", () => {
    const projection = projectWorkPackages(
      input({
        checkoffLinks: [
          checkoffLink({ id: "a", state: "dismissed" }),
          checkoffLink({ id: "b", profile_id: 99 }),
        ],
      }),
    );
    expect(projection.active).toHaveLength(0);
  });
});

describe("workPackageStatusOwner", () => {
  it("names who each pending state waits on", () => {
    expect(workPackageStatusOwner("awaiting_sliced_file")).toBe("Waiting for your slicer");
    expect(workPackageStatusOwner("printing")).toBe("Waiting for the printer");
    expect(workPackageStatusOwner("needs_verification")).toBe("Waiting for you in Checkoff");
  });
});

import { describe, expect, it } from "vitest";
import type { AcceptedPlateWorkspace, RequiredUnitToken } from "@print-partner/contracts";
import type { WorkPackage } from "./workPackageProjection";
import {
  firstUnfinishedProductionTask,
  PRODUCTION_TASK_IDS,
  PRODUCTION_TASK_ROUTE,
  productionStageAlias,
  productionTaskFromParam,
  productionTasks,
  type ExternalTaskInput,
  type PlatesTaskInput,
  type ProductionTask,
  type StlTaskInput,
} from "./workPackageTasks";

const TOKEN_A = `ppu_${"a".repeat(32)}` as RequiredUnitToken;

const printer = {
  id: "printer-1",
  name: "Voron",
  model: "2.4",
  bed_width_um: 350_000,
  bed_depth_um: 350_000,
  bed_height_um: 350_000,
  margin_um: 5_000,
};

const basis = {
  profile_id: 1,
  plan_version: 4,
  plan_revision_id: 12,
  plan_revision_digest: "0".repeat(64),
  required_unit_mapping_digest: "1".repeat(64),
};

function readyWorkspace(
  overrides: Partial<Extract<AcceptedPlateWorkspace, { kind: "ready" }>> = {},
): AcceptedPlateWorkspace {
  return {
    kind: "ready",
    basis,
    plate_revision_id: 90,
    plate_revision_number: 3,
    arrange_undo_revision_id: null,
    printers: [printer],
    plates: [{ plate_id: "plate_1", ordinal: 1, printer, units: [] }],
    unplaced: [],
    unassigned: [],
    ...overrides,
  } as AcceptedPlateWorkspace;
}

function pkg(overrides: Partial<WorkPackage["links"]> = {}): WorkPackage {
  return {
    id: "bench-plate-90",
    kind: "bench",
    route: "plates",
    title: "Next work package",
    status: "ready_to_slice",
    statusLabel: "Ready to slice",
    summary: "",
    unitCount: 1,
    completedUnitCount: 0,
    plateCount: 1,
    blockedReason: null,
    links: {
      acceptedPlan: { revisionId: 12, version: 4 },
      unitTokens: [TOKEN_A],
      plateRevision: { id: 90, number: 3 },
      exportArtifact: null,
      slicedFile: null,
      printer: null,
      sendJob: null,
      verification: null,
      ...overrides,
    },
  };
}

function platesInput(overrides: Partial<PlatesTaskInput> = {}): PlatesTaskInput {
  return {
    route: "plates",
    pkg: pkg(),
    workspace: readyWorkspace(),
    selectedCount: 1,
    totalUnitCount: 22,
    printerCount: 1,
    sendPrinterCount: 1,
    dispatchedFilenames: [],
    exportError: null,
    sendError: null,
    plateError: null,
    assignError: null,
    ...overrides,
  };
}

function stlInput(overrides: Partial<StlTaskInput> = {}): StlTaskInput {
  return {
    route: "stl",
    pkg: pkg(),
    selectedCount: 2,
    totalUnitCount: 22,
    ...overrides,
  };
}

function externalInput(overrides: Partial<ExternalTaskInput> = {}): ExternalTaskInput {
  return {
    route: "external",
    pkg: pkg(),
    recordedPrintCount: 0,
    ...overrides,
  };
}

const byId = (tasks: readonly ProductionTask[], id: string) =>
  tasks.find((task) => task.id === id)!;

const noPlan = pkg({ acceptedPlan: null });

describe("productionTasks on the Plates route", () => {
  it("keeps Plate preparation together in a four-part flow", () => {
    expect(productionTasks(platesInput()).map((task) => task.id)).toEqual([
      "prepare-plates",
      "export-for-slicing",
      "add-sliced-file",
      "send-or-start",
    ]);
  });

  it("blocks only genuinely blocked tasks and gives each one a reason", () => {
    const tasks = productionTasks(platesInput({ selectedCount: 0 }));
    expect(byId(tasks, "prepare-plates").state).toBe("needs_attention");
    expect(byId(tasks, "prepare-plates").disabledReason).toBeNull();
  });

  it("keeps Plate preparation open when no printer exists and says where to go", () => {
    const tasks = productionTasks(platesInput({ printerCount: 0 }));
    expect(byId(tasks, "prepare-plates").state).toBe("needs_attention");
    expect(byId(tasks, "prepare-plates").hint).toContain("Add a printer in Settings");
  });

  it("marks Arrange Plates as needing a decision while units are unplaced", () => {
    const workspace = readyWorkspace({
      unplaced: [
        {
          token: TOKEN_A,
          object_name: `part__${TOKEN_A}`,
          filename: "part.stl",
          relative_path: "",
          source_directory: "",
          source_layer: "kit",
          role: "frame",
          filament_color_id: null,
          completed: false,
          plate_id: "plate_1",
          printer_id: "printer-1",
          width_um: 10_000,
          depth_um: 10_000,
          height_um: 10_000,
        },
      ],
    } as never);
    const tasks = productionTasks(platesInput({ workspace }));
    expect(byId(tasks, "prepare-plates").state).toBe("needs_attention");
    expect(byId(tasks, "export-for-slicing").state).toBe("blocked");
  });

  it("keeps Export complete and reviewable after the artifact exists", () => {
    const tasks = productionTasks(
      platesInput({
        pkg: pkg({
          exportArtifact: {
            jobId: "job-90",
            plateRevisionNumber: 3,
            plateCount: 2,
            bundleUrl: "/exports/a.zip",
          },
        }),
      }),
    );
    expect(byId(tasks, "export-for-slicing").state).toBe("complete");
    expect(byId(tasks, "add-sliced-file").state).toBe("needs_attention");
    expect(byId(tasks, "add-sliced-file").statusLabel).toBe("Waiting for your slicer");
    expect(byId(tasks, "send-or-start").state).toBe("blocked");
  });

  it("turns a failed operation into an error state, not a blocked task", () => {
    const tasks = productionTasks(platesInput({ plateError: "Plate conflict" }));
    expect(byId(tasks, "prepare-plates").state).toBe("error");
    expect(byId(tasks, "prepare-plates").statusLabel).toBe("Failed, retry available");
  });

  it("blocks Send when no printer is linked to a host and names the fix", () => {
    const tasks = productionTasks(
      platesInput({
        pkg: pkg({
          exportArtifact: {
            jobId: "job-90",
            plateRevisionNumber: 3,
            plateCount: 1,
            bundleUrl: "/exports/a.zip",
          },
          slicedFile: { name: "batch.gcode" },
        }),
        sendPrinterCount: 0,
      }),
    );
    expect(byId(tasks, "send-or-start").state).toBe("blocked");
    expect(byId(tasks, "send-or-start").disabledReason).toContain("Link a printer");
  });

  it("completes Send when the sliced file is already at a printer", () => {
    const tasks = productionTasks(
      platesInput({
        pkg: pkg({
          exportArtifact: {
            jobId: "job-90",
            plateRevisionNumber: 3,
            plateCount: 1,
            bundleUrl: "/exports/a.zip",
          },
          slicedFile: { name: "batch.gcode" },
        }),
        dispatchedFilenames: ["batch.gcode"],
      }),
    );
    expect(byId(tasks, "send-or-start").state).toBe("complete");
  });
});

describe("productionTasks on the unit-files route", () => {
  it("lists only its own two tasks, with no Plate or printer task present", () => {
    const ids = productionTasks(stlInput()).map((task) => task.id);
    expect(ids).toEqual(["choose-units", "download-stl"]);
    expect(ids).not.toContain("prepare-plates");
    expect(ids).not.toContain("send-or-start");
  });

  it("blocks the download until at least one unit is chosen", () => {
    const tasks = productionTasks(stlInput({ selectedCount: 0 }));
    expect(byId(tasks, "choose-units").state).toBe("needs_attention");
    expect(byId(tasks, "download-stl").state).toBe("blocked");
    expect(byId(tasks, "download-stl").disabledReason).toContain("Choose at least one");
  });

  it("never claims the download is complete, and names Checkoff as the exit", () => {
    const tasks = productionTasks(stlInput());
    expect(byId(tasks, "choose-units").state).toBe("complete");
    expect(byId(tasks, "download-stl").state).toBe("not_started");
    expect(byId(tasks, "download-stl").statusLabel).toBe("Needs your decision");
    expect(byId(tasks, "download-stl").hint).toContain("Checkoff");
  });

  it("blocks both tasks with a reason when the Build has no accepted units", () => {
    const tasks = productionTasks(stlInput({ pkg: noPlan, selectedCount: 0 }));
    expect(byId(tasks, "choose-units").state).toBe("blocked");
    expect(byId(tasks, "choose-units").disabledReason).toContain("Accept a Plan revision");
  });
});

describe("productionTasks on the record-a-print route", () => {
  it("lists only its own three tasks", () => {
    expect(productionTasks(externalInput()).map((task) => task.id)).toEqual([
      "pick-print-file",
      "attribute-units",
      "confirm-record",
    ]);
  });

  it("asks for a decision until a print is on the record", () => {
    const tasks = productionTasks(externalInput());
    for (const task of tasks) {
      expect(task.state).toBe("needs_attention");
      expect(task.disabledReason).toBeNull();
    }
    expect(byId(tasks, "pick-print-file").hint).toContain("upload G-code");
  });

  it("completes every step once a print is recorded", () => {
    const tasks = productionTasks(externalInput({ recordedPrintCount: 2 }));
    for (const task of tasks) expect(task.state).toBe("complete");
    expect(byId(tasks, "pick-print-file").hint).toBe("2 prints recorded for this Build.");
  });

  it("blocks the route when there is nothing to attribute a print to", () => {
    const tasks = productionTasks(externalInput({ pkg: noPlan }));
    for (const task of tasks) {
      expect(task.state).toBe("blocked");
      expect(task.disabledReason).toContain("Accept a Plan revision");
    }
  });
});

describe("firstUnfinishedProductionTask", () => {
  it("resumes at the first task that still needs work on the Plates route", () => {
    expect(
      firstUnfinishedProductionTask({
        tasks: productionTasks(platesInput({ selectedCount: 0 })),
        route: "plates",
      }),
    ).toBe("prepare-plates");
    expect(
      firstUnfinishedProductionTask({ tasks: productionTasks(platesInput()), route: "plates" }),
    ).toBe("export-for-slicing");
    expect(
      firstUnfinishedProductionTask({
        tasks: productionTasks(
          platesInput({
            pkg: pkg({
              exportArtifact: {
                jobId: "job-90",
                plateRevisionNumber: 3,
                plateCount: 1,
                bundleUrl: "/exports/a.zip",
              },
            }),
          }),
        ),
        route: "plates",
      }),
    ).toBe("add-sliced-file");
  });

  it("resumes at the download once units are chosen on the unit-files route", () => {
    expect(
      firstUnfinishedProductionTask({ tasks: productionTasks(stlInput()), route: "stl" }),
    ).toBe("download-stl");
  });

  it("falls back to the route's own first task when there is nothing to resume", () => {
    expect(firstUnfinishedProductionTask({ tasks: [], route: "stl" })).toBe("choose-units");
    expect(firstUnfinishedProductionTask({ tasks: [], route: "external" })).toBe(
      "pick-print-file",
    );
  });
});

describe("productionTaskFromParam", () => {
  it("accepts a task id from every route", () => {
    expect(productionTaskFromParam("prepare-plates")).toBe("prepare-plates");
    expect(productionTaskFromParam("download-stl")).toBe("download-stl");
    expect(productionTaskFromParam("confirm-record")).toBe("confirm-record");
  });

  it("keeps the old numbered stages and split-task ids working as aliases", () => {
    expect(productionTaskFromParam("parts")).toBe("prepare-plates");
    expect(productionTaskFromParam("plates")).toBe("prepare-plates");
    expect(productionTaskFromParam("select-work")).toBe("prepare-plates");
    expect(productionTaskFromParam("assign-printers")).toBe("prepare-plates");
    expect(productionTaskFromParam("arrange-plates")).toBe("prepare-plates");
    expect(productionTaskFromParam("export")).toBe("export-for-slicing");
    expect(productionTaskFromParam("send")).toBe("send-or-start");
  });

  it("resolves every legacy alias into the Plates route", () => {
    for (const alias of [
      "parts",
      "plates",
      "export",
      "send",
      "select-work",
      "assign-printers",
      "arrange-plates",
    ]) {
      const task = productionTaskFromParam(alias)!;
      expect(PRODUCTION_TASK_ROUTE[task]).toBe("plates");
    }
  });

  it("returns nothing for an unknown value", () => {
    expect(productionTaskFromParam("nonsense")).toBeNull();
    expect(productionTaskFromParam(null)).toBeNull();
  });

  it("maps a Plates task back to a stage value old links understand", () => {
    expect(productionStageAlias("prepare-plates")).toBe("plates");
    expect(productionStageAlias("export-for-slicing")).toBe("export");
    expect(productionStageAlias("send-or-start")).toBe("send");
  });

  it("gives the newer routes no stage value, because they never had one", () => {
    expect(productionStageAlias("download-stl")).toBeNull();
    expect(productionStageAlias("confirm-record")).toBeNull();
  });
});

describe("PRODUCTION_TASK_IDS", () => {
  it("keeps the Plates ids byte for byte, so saved links keep resolving", () => {
    expect(PRODUCTION_TASK_IDS.plates).toEqual([
      "prepare-plates",
      "export-for-slicing",
      "add-sliced-file",
      "send-or-start",
    ]);
  });

  it("gives every task exactly one route", () => {
    for (const [route, ids] of Object.entries(PRODUCTION_TASK_IDS)) {
      for (const id of ids) expect(PRODUCTION_TASK_ROUTE[id]).toBe(route);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { AcceptedPlateWorkspace, RequiredUnitToken } from "@print-partner/contracts";
import type { WorkPackage } from "./workPackageProjection";
import {
  firstUnfinishedProductionTask,
  productionStageAlias,
  productionTaskFromParam,
  productionTasks,
  type ProductionTaskInput,
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

function input(overrides: Partial<ProductionTaskInput> = {}): ProductionTaskInput {
  return {
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
    ...overrides,
  };
}

const byId = (tasks: ReturnType<typeof productionTasks>, id: string) =>
  tasks.find((task) => task.id === id)!;

describe("productionTasks", () => {
  it("keeps Plate preparation together in a four-part Production flow", () => {
    expect(productionTasks(input()).map((task) => task.id)).toEqual([
      "prepare-plates",
      "export-for-slicing",
      "add-sliced-file",
      "send-or-start",
    ]);
  });

  it("blocks only genuinely blocked tasks and gives each one a reason", () => {
    const tasks = productionTasks(input({ selectedCount: 0 }));
    expect(byId(tasks, "prepare-plates").state).toBe("needs_attention");
    expect(byId(tasks, "prepare-plates").disabledReason).toBeNull();
  });

  it("keeps Plate preparation open when no printer exists and says where to go", () => {
    const tasks = productionTasks(input({ printerCount: 0 }));
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
    const tasks = productionTasks(input({ workspace }));
    expect(byId(tasks, "prepare-plates").state).toBe("needs_attention");
    expect(byId(tasks, "export-for-slicing").state).toBe("blocked");
  });

  it("keeps Export complete and reviewable after the artifact exists", () => {
    const tasks = productionTasks(
      input({
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
    const tasks = productionTasks(input({ plateError: "Plate conflict" }));
    expect(byId(tasks, "prepare-plates").state).toBe("error");
    expect(byId(tasks, "prepare-plates").statusLabel).toBe("Failed, retry available");
  });

  it("blocks Send when no printer is linked to a host and names the fix", () => {
    const tasks = productionTasks(
      input({
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
      input({
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

describe("firstUnfinishedProductionTask", () => {
  it("resumes at the first task that still needs work", () => {
    expect(firstUnfinishedProductionTask(productionTasks(input({ selectedCount: 0 }))))
      .toBe("prepare-plates");
    expect(firstUnfinishedProductionTask(productionTasks(input()))).toBe("export-for-slicing");
    expect(
      firstUnfinishedProductionTask(
        productionTasks(
          input({
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
      ),
    ).toBe("add-sliced-file");
  });
});

describe("productionTaskFromParam", () => {
  it("accepts the new task ids", () => {
    expect(productionTaskFromParam("prepare-plates")).toBe("prepare-plates");
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

  it("returns nothing for an unknown value", () => {
    expect(productionTaskFromParam("nonsense")).toBeNull();
    expect(productionTaskFromParam(null)).toBeNull();
  });

  it("maps a task back to a stage value old links understand", () => {
    expect(productionStageAlias("prepare-plates")).toBe("plates");
  });
});

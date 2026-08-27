import type { AcceptedPlateWorkspace } from "@print-partner/contracts";
import type { WorkflowTaskState } from "../components/layout/TaskList";
import type { WorkPackage } from "./workPackageProjection";

/**
 * Production work is a list of resumable tasks, not a numbered pass. The user
 * may leave after "Export for slicing", slice somewhere else, and come back
 * hours later on another machine. Only genuinely blocked tasks are unavailable,
 * completed tasks stay open for review, and the page reopens at the first
 * unfinished task.
 */
export const PRODUCTION_TASK_IDS = [
  "prepare-plates",
  "export-for-slicing",
  "add-sliced-file",
  "send-or-start",
] as const;

export type ProductionTaskId = (typeof PRODUCTION_TASK_IDS)[number];

export type ProductionTask = Readonly<{
  id: ProductionTaskId;
  label: string;
  hint: string;
  state: WorkflowTaskState;
  /** Names the state and its owner. */
  statusLabel: string;
  /** Set only when the task is blocked. Says what must happen first. */
  disabledReason: string | null;
}>;

/**
 * The old numbered tabs live on as URL aliases so saved links and the Checkoff
 * "Prepare missing parts" link keep working.
 */
const STAGE_ALIASES: Readonly<Record<string, ProductionTaskId>> = {
  parts: "prepare-plates",
  plates: "prepare-plates",
  export: "export-for-slicing",
  send: "send-or-start",
};

const SPLIT_TASK_ALIASES: Readonly<Record<string, ProductionTaskId>> = {
  "select-work": "prepare-plates",
  "assign-printers": "prepare-plates",
  "arrange-plates": "prepare-plates",
};

export function productionTaskFromParam(value: string | null): ProductionTaskId | null {
  if (!value) return null;
  if ((PRODUCTION_TASK_IDS as readonly string[]).includes(value)) {
    return value as ProductionTaskId;
  }
  return STAGE_ALIASES[value] ?? SPLIT_TASK_ALIASES[value] ?? null;
}

/** The `?stage=` value that still points at a task, for backward-compatible links. */
export function productionStageAlias(task: ProductionTaskId): string {
  if (task === "prepare-plates") return "plates";
  const entry = Object.entries(STAGE_ALIASES).find(([, id]) => id === task);
  if (entry) return entry[0];
  return "send";
}

export type ProductionTaskInput = Readonly<{
  pkg: WorkPackage;
  workspace: AcceptedPlateWorkspace | undefined;
  selectedCount: number;
  totalUnitCount: number;
  printerCount: number;
  /** Printers with a linked host, the only ones a sliced file can go to. */
  sendPrinterCount: number;
  /** Filenames of packages already sent to a printer for this Build. */
  dispatchedFilenames: readonly string[];
  exportError: string | null;
  sendError: string | null;
  plateError: string | null;
  assignError?: string | null;
}>;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function productionTasks(input: ProductionTaskInput): ProductionTask[] {
  const workspace = input.workspace;
  const ready = workspace?.kind === "ready" ? workspace : null;
  const isSetup = workspace?.kind === "setup";
  const noPlan = workspace == null || workspace.kind === "empty_plan";
  const unassigned = ready?.unassigned.length ?? 0;
  const unplaced = ready?.unplaced.length ?? 0;
  const links = input.pkg.links;

  const selected = input.selectedCount > 0;
  const assigned = ready != null && unassigned === 0;
  const arranged = assigned && unplaced === 0;
  const prepared = selected && input.printerCount > 0 && arranged && !isSetup;
  const exported = links.exportArtifact != null;
  const sliced = links.slicedFile != null;
  const sent = sliced
    ? input.dispatchedFilenames.includes(links.slicedFile?.name ?? "")
    : input.dispatchedFilenames.length > 0;

  const preparationFailed = input.assignError != null || input.plateError != null;
  const preparePlates: ProductionTask = {
    id: "prepare-plates",
    label: "Prepare Plates",
    hint: noPlan
      ? "No accepted Required units yet."
      : !selected
        ? "Choose the Required units this package will make."
        : input.printerCount === 0
          ? `${plural(input.selectedCount, "unit", "units")} chosen. Add a printer in Settings to continue.`
          : !assigned
            ? unassigned > 0
              ? `${plural(unassigned, "unit needs", "units need")} a printer. Assign by Source layer, directory, color, role, or part.`
              : "Assign by Source layer, directory, color, role, or part, then build the Plates."
            : unplaced > 0
              ? `${plural(unplaced, "unit does", "units do")} not fit where they are. Review the Plate layout.`
              : ready
                ? `Plate revision ${ready.plate_revision_number} has ${plural(ready.plates.length, "Plate", "Plates")} ready to export.`
                : "Choose units, assign printers, and review the Plate layout.",
    state: noPlan
      ? "blocked"
      : preparationFailed
        ? "error"
        : prepared
          ? "complete"
          : "needs_attention",
    statusLabel: noPlan
      ? "Unavailable"
      : preparationFailed
        ? "Failed, retry available"
        : prepared
          ? "Complete"
          : "Needs your decision",
    disabledReason: noPlan
      ? "Accept a Plan revision with Required units on the Plan workspace first."
      : null,
  };

  const exportForSlicing: ProductionTask = {
    id: "export-for-slicing",
    label: "Export for slicing",
    hint: !arranged
      ? "Available once every unit sits on a Plate."
      : input.exportError
        ? "The last export did not finish."
        : exported
          ? `Plate revision ${links.exportArtifact?.plateRevisionNumber} exported as ${plural(links.exportArtifact?.plateCount ?? 0, "3MF file", "3MF files")}.`
          : "Send the arranged Plates to your slicer, or download the 3MF.",
    state: !arranged
      ? "blocked"
      : input.exportError
        ? "error"
        : exported
          ? "complete"
          : "not_started",
    statusLabel: !arranged
      ? "Unavailable"
      : input.exportError
        ? "Failed, retry available"
        : exported
          ? "Complete"
          : "Needs your decision",
    disabledReason: !arranged ? "Arrange every unit on a Plate before you export." : null,
  };

  const addSlicedFile: ProductionTask = {
    id: "add-sliced-file",
    label: "Add sliced file",
    hint: !exported
      ? "Available after you export this package."
      : sliced
        ? `${links.slicedFile?.name} is ready to send.`
        : "Slice the exported files, then add the G-code here. You can come back later.",
    state: !exported ? "blocked" : sliced ? "complete" : "needs_attention",
    statusLabel: !exported
      ? "Unavailable"
      : sliced
        ? "Complete"
        : "Waiting for your slicer",
    disabledReason: !exported ? "Export this package before you add a sliced file." : null,
  };

  const noSendPrinter = input.sendPrinterCount === 0;
  const sendBlocked = (!sliced && !sent) || (noSendPrinter && !sent);
  const sendOrStart: ProductionTask = {
    id: "send-or-start",
    label: "Send or start",
    hint: !sliced && !sent
      ? "Available once a sliced file is added."
      : noSendPrinter && !sent
        ? "No printer is linked to a host yet."
        : input.sendError
          ? "The last send did not reach the printer."
          : sent
            ? "This file is at a printer. Track it above and verify it in Checkoff."
            : "Send the file to a printer, or start the print now.",
    state: sendBlocked
      ? "blocked"
      : input.sendError
        ? "error"
        : sent
          ? "complete"
          : "not_started",
    statusLabel: sendBlocked
      ? "Unavailable"
      : input.sendError
        ? "Failed, retry available"
        : sent
          ? "Complete"
          : "Needs your decision",
    disabledReason: !sliced && !sent
      ? "Add a sliced file before you send."
      : sendBlocked
        ? "Link a printer to a Klipper, Prusa or Bambu host in Settings before you send."
        : null,
  };

  return [
    preparePlates,
    exportForSlicing,
    addSlicedFile,
    sendOrStart,
  ];
}

/**
 * Where the page reopens after a reload or a move to another device: the first
 * task that is not finished. Blocked tasks count as unfinished, because they
 * still tell the user what is missing.
 */
export function firstUnfinishedProductionTask(
  tasks: readonly ProductionTask[],
): ProductionTaskId {
  const unfinished = tasks.find((task) => task.state !== "complete" && task.state !== "blocked");
  if (unfinished) return unfinished.id;
  const blocked = tasks.find((task) => task.state === "blocked");
  return blocked?.id ?? tasks[tasks.length - 1]?.id ?? "prepare-plates";
}

/** A task is openable unless it is genuinely blocked. */
export function isProductionTaskAvailable(task: ProductionTask): boolean {
  return task.state !== "blocked";
}

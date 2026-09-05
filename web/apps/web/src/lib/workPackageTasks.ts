import type { AcceptedPlateWorkspace, ProductionRoute } from "@print-partner/contracts";
import type { WorkflowTaskState } from "../components/layout/TaskList";
import type { WorkPackage } from "./workPackageProjection";

/**
 * Production work is a list of resumable tasks, not a numbered pass. The user
 * may leave after "Export for slicing", slice somewhere else, and come back
 * hours later on another machine. Only genuinely blocked tasks are unavailable,
 * completed tasks stay open for review, and the page reopens at the first
 * unfinished task.
 *
 * The list belongs to a route, not to the page. A Build on the `stl` route
 * never sees "Send or start": the task is absent rather than greyed out,
 * because a row the operator can never reach reads as a permission problem
 * (GOV.UK Design System, tabs: do not disable elements).
 *
 * The `plates` ids are the four this page has always had, so saved links, the
 * `?stage=` aliases and the Checkoff "Prepare missing parts" link keep working
 * untouched.
 */
export const PRODUCTION_TASK_IDS = {
  plates: ["prepare-plates", "export-for-slicing", "add-sliced-file", "send-or-start"],
  stl: ["choose-units", "download-stl"],
  external: ["pick-print-file", "attribute-units", "confirm-record"],
} as const satisfies Readonly<Record<ProductionRoute, readonly [string, ...string[]]>>;

export type ProductionTaskId = (typeof PRODUCTION_TASK_IDS)[ProductionRoute][number];

/**
 * Route order on the question: most common first, with the record route last
 * because it is phrased differently from the other two. GOV.UK cautions that
 * frequency ordering can reinforce bias, so retuning this order needs evidence.
 */
export const PRODUCTION_ROUTE_ORDER = [
  "plates",
  "stl",
  "external",
] as const satisfies readonly ProductionRoute[];

/**
 * Compile guard: a route added to the contract but left out of the order above
 * would silently vanish from the question. This line breaks the build instead.
 */
type UnorderedRoute = Exclude<ProductionRoute, (typeof PRODUCTION_ROUTE_ORDER)[number]>;
const _everyRouteIsOrdered: UnorderedRoute[] = [];
void _everyRouteIsOrdered;

/** The route names the operator reads. Also used in the change confirmation. */
export const PRODUCTION_ROUTE_LABEL: Readonly<Record<ProductionRoute, string>> = {
  plates: "Generate 3MF plates",
  stl: "Download sorted STL files",
  external: "Add manually prepared prints",
};

/** One line under each route name on the question. */
export const PRODUCTION_ROUTE_DESCRIPTION: Readonly<Record<ProductionRoute, string>> = {
  plates:
    "Arrange selected parts into plates using each printer's build volume and your color, material, and part-type sorting.",
  stl:
    "Download selected STL files organized by color, material, part type, and your other sorting choices.",
  external:
    "Use this when you sliced or sent one or more jobs yourself. Add each 3MF or G-code file, then verify its parts in Checkoff.",
};

/**
 * Which route each task id belongs to, so a `?task=` or legacy `?stage=` link
 * can be checked against the route the work package is actually on. A new task
 * id without a route fails to compile.
 */
export const PRODUCTION_TASK_ROUTE: Readonly<Record<ProductionTaskId, ProductionRoute>> = {
  "prepare-plates": "plates",
  "export-for-slicing": "plates",
  "add-sliced-file": "plates",
  "send-or-start": "plates",
  "choose-units": "stl",
  "download-stl": "stl",
  "pick-print-file": "external",
  "attribute-units": "external",
  "confirm-record": "external",
};

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

const ALL_TASK_IDS: readonly ProductionTaskId[] = PRODUCTION_ROUTE_ORDER.flatMap(
  (route) => PRODUCTION_TASK_IDS[route],
);

/**
 * The old numbered tabs live on as URL aliases so saved links and the Checkoff
 * "Prepare missing parts" link keep working. Every alias resolves into the
 * `plates` route, because that route is the flow those links were written
 * against.
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
  const known = ALL_TASK_IDS.find((id) => id === value);
  if (known) return known;
  return STAGE_ALIASES[value] ?? SPLIT_TASK_ALIASES[value] ?? null;
}

/**
 * The `?stage=` value that still points at a task, for backward-compatible
 * links. Only the `plates` route ever had numbered stages, so tasks on the
 * other two routes have no stage to write.
 */
export function productionStageAlias(task: ProductionTaskId): string | null {
  switch (task) {
    case "prepare-plates":
      return "plates";
    case "export-for-slicing":
      return "export";
    case "add-sliced-file":
    case "send-or-start":
      return "send";
    case "choose-units":
    case "download-stl":
    case "pick-print-file":
    case "attribute-units":
    case "confirm-record":
      return null;
  }
}

type TaskInputBase = Readonly<{ pkg: WorkPackage }>;

export type PlatesTaskInput = TaskInputBase &
  Readonly<{
    route: "plates";
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
    assignError: string | null;
  }>;

export type StlTaskInput = TaskInputBase &
  Readonly<{
    route: "stl";
    selectedCount: number;
    totalUnitCount: number;
  }>;

export type ExternalTaskInput = TaskInputBase &
  Readonly<{
    route: "external";
    /** Prints already recorded for this Build. */
    recordedPrintCount: number;
  }>;

export type ProductionTaskInput = PlatesTaskInput | StlTaskInput | ExternalTaskInput;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function platesTasks(input: PlatesTaskInput): ProductionTask[] {
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
      ? "No parts chosen yet."
      : !selected
        ? "Choose the parts to print."
        : input.printerCount === 0
          ? `${plural(input.selectedCount, "unit", "units")} chosen. Add a printer in Settings to continue.`
          : !assigned
            ? unassigned > 0
              ? `${plural(unassigned, "unit needs", "units need")} a printer. Assign by Source layer, directory, color, role, or part.`
              : "Assign by Source layer, directory, color, role, or part, then prepare the Plates."
            : unplaced > 0
              ? `${plural(unplaced, "unit does", "units do")} not fit where they are. Review the Plate layout.`
              : ready
                ? `${plural(ready.plates.length, "Plate", "Plates")} ready to export.`
                : "Choose parts, assign printers, and review the Plate layout.",
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
      ? "Choose the parts to print on Plan first."
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

  return [preparePlates, exportForSlicing, addSlicedFile, sendOrStart];
}

/**
 * The unit-files route has no finish line inside PrintPartner.
 *
 * "Export for slicing" leaves a durable artifact the page can read back, so the
 * `plates` route can honestly say Complete. A download leaves nothing: the
 * operator may take the files ten times, and PrintPartner never sees the
 * printer they go to. So "Download the unit files" stays at "Needs your
 * decision" for as long as the package exists, and the work package says in
 * words that Checkoff is where these units get verified. Marking the task
 * Complete on the click that starts a download would claim knowledge the
 * product does not have.
 *
 * This is the answer to the open question in
 * docs/audits/2026-08-28-production-route-choice-research.md: handing over
 * files ends PrintPartner's involvement, and the units stay unverified until
 * the operator records a print.
 */
function stlTasks(input: StlTaskInput): ProductionTask[] {
  const noPlan = input.pkg.links.acceptedPlan == null;
  const selected = input.selectedCount > 0;

  const chooseUnits: ProductionTask = {
    id: "choose-units",
    label: "Choose parts",
    hint: noPlan
      ? "No parts chosen yet."
      : selected
        ? `${plural(input.selectedCount, "unit", "units")} chosen out of ${input.totalUnitCount}.`
        : "Choose the parts you want to download.",
    state: noPlan ? "blocked" : selected ? "complete" : "needs_attention",
    statusLabel: noPlan ? "Unavailable" : selected ? "Complete" : "Needs your decision",
    disabledReason: noPlan
      ? "Choose the parts to print on Plan first."
      : null,
  };

  const downloadFiles: ProductionTask = {
    id: "download-stl",
    label: "Download sorted STL files",
    hint: !selected
      ? "Available once you choose at least one Required unit."
      : "Take the files as often as you need. PrintPartner cannot see what you print from them, so record the print in Checkoff when it is done.",
    state: !selected ? "blocked" : "not_started",
    statusLabel: !selected ? "Unavailable" : "Needs your decision",
    disabledReason: !selected
      ? "Choose at least one Required unit before you download."
      : null,
  };

  return [chooseUnits, downloadFiles];
}

/**
 * Recording a print made elsewhere is one panel, not three screens: the
 * operator picks a file, says which Required units it covers, and confirms.
 * The three rows below name those steps so the operator can see the whole job
 * before starting it, and they all open the same panel. Every row turns
 * Complete together once a print is on the record, because that is the only
 * moment the page can observe.
 */
function externalTasks(input: ExternalTaskInput): ProductionTask[] {
  const noPlan = input.pkg.links.acceptedPlan == null;
  const recorded = input.recordedPrintCount > 0;
  const state: WorkflowTaskState = noPlan
    ? "blocked"
    : recorded
      ? "complete"
      : "needs_attention";
  const statusLabel = noPlan ? "Unavailable" : recorded ? "Complete" : "Needs your decision";
  const disabledReason = noPlan
    ? "Choose the parts to print on Plan first."
    : null;
  const recordedLine = `${plural(input.recordedPrintCount, "print", "prints")} recorded for this Build.`;

  return [
    {
      id: "pick-print-file",
      label: "Choose the print file",
      hint: noPlan
        ? "No parts chosen yet."
        : recorded
          ? recordedLine
          : "Pick a file from a linked printer, or upload G-code, binary G-code or a 3MF file.",
      state,
      statusLabel,
      disabledReason,
    },
    {
      id: "attribute-units",
      label: "Choose the printed parts",
      hint: noPlan
        ? "No parts chosen yet."
        : recorded
          ? "Every recorded print carries the units it covers."
          : "Say which Required units this print already made.",
      state,
      statusLabel,
      disabledReason,
    },
    {
      id: "confirm-record",
      label: "Confirm the record",
      hint: noPlan
        ? "No parts chosen yet."
        : recorded
          ? "Units you had already checked are checked off. Anything else is waiting in Checkoff."
          : "Say whether you have checked the parts, then confirm. Units you have checked are checked off here.",
      state,
      statusLabel,
      disabledReason,
    },
  ];
}

export function productionTasks(input: ProductionTaskInput): ProductionTask[] {
  switch (input.route) {
    case "plates":
      return platesTasks(input);
    case "stl":
      return stlTasks(input);
    case "external":
      return externalTasks(input);
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

/**
 * Where the page reopens after a reload or a move to another device: the first
 * task that is not finished. Blocked tasks count as unfinished, because they
 * still tell the user what is missing.
 */
export function firstUnfinishedProductionTask(input: {
  tasks: readonly ProductionTask[];
  route: ProductionRoute;
}): ProductionTaskId {
  const unfinished = input.tasks.find(
    (task) => task.state !== "complete" && task.state !== "blocked",
  );
  if (unfinished) return unfinished.id;
  const blocked = input.tasks.find((task) => task.state === "blocked");
  return blocked?.id ?? PRODUCTION_TASK_IDS[input.route][0];
}

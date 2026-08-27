import type {
  AcceptedPlateExportRecord,
  AcceptedPlateWorkspace,
  ProductionSetup,
  RequiredUnitToken,
} from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../api/endpoints/checkoff";
import type { ProductionSelectableUnit } from "./productionSelection";
import { progressRoute } from "./routes";

/**
 * A Production work package is the continuity object that survives the trip out
 * of PrintPartner: select units here, slice in another program, come back later
 * (maybe on another machine) with G-code, send it, then verify in Checkoff.
 *
 * Nothing in the product stores a work package as its own row. This module
 * projects one from the records that already exist: the production setup, the
 * accepted Plate revision, the accepted Plate export jobs, and the printer
 * checkoff links written at send time. That keeps the view durable without a
 * new server table, and it keeps every status derived from real state instead
 * of a `?stage=` URL parameter.
 */

export type WorkPackageStatus =
  | "preparing"
  | "ready_to_slice"
  | "awaiting_sliced_file"
  | "ready_to_send"
  | "queued"
  | "printing"
  | "needs_verification"
  | "failed"
  | "complete";

export const WORK_PACKAGE_STATUS_LABEL: Record<WorkPackageStatus, string> = {
  preparing: "Preparing",
  ready_to_slice: "Ready to slice",
  awaiting_sliced_file: "Awaiting sliced file",
  ready_to_send: "Ready to send",
  queued: "Queued",
  printing: "Printing",
  needs_verification: "Needs verification",
  failed: "Failed",
  complete: "Complete",
};

export type WorkPackageTone = "neutral" | "info" | "warning" | "success" | "error";

const STATUS_TONE: Record<WorkPackageStatus, WorkPackageTone> = {
  preparing: "neutral",
  ready_to_slice: "info",
  awaiting_sliced_file: "warning",
  ready_to_send: "info",
  queued: "info",
  printing: "info",
  needs_verification: "warning",
  failed: "error",
  complete: "success",
};

export function workPackageStatusTone(status: WorkPackageStatus): WorkPackageTone {
  return STATUS_TONE[status];
}

/** Who the package is waiting on. Every pending state names an owner. */
const STATUS_OWNER: Record<WorkPackageStatus, string> = {
  preparing: "Waiting for you",
  ready_to_slice: "Waiting for you",
  awaiting_sliced_file: "Waiting for your slicer",
  ready_to_send: "Waiting for you",
  queued: "Waiting for the printer",
  printing: "Waiting for the printer",
  needs_verification: "Waiting for you in Checkoff",
  failed: "Waiting for you",
  complete: "Nothing left to do",
};

export function workPackageStatusOwner(status: WorkPackageStatus): string {
  return STATUS_OWNER[status];
}

export type WorkPackageLinks = Readonly<{
  /** The accepted Plan revision every downstream record belongs to. */
  acceptedPlan: Readonly<{ revisionId: number; version: number }> | null;
  /** Required-unit tokens this package covers. */
  unitTokens: readonly RequiredUnitToken[];
  plateRevision: Readonly<{ id: number; number: number }> | null;
  exportArtifact: Readonly<{
    jobId: string;
    plateRevisionNumber: number;
    plateCount: number;
    bundleUrl: string;
  }> | null;
  slicedFile: Readonly<{ name: string }> | null;
  printer: Readonly<{ id: string; name: string }> | null;
  sendJob: Readonly<{ linkId: string; filename: string; sentAt: string }> | null;
  verification: Readonly<{ route: string; unitsMarked: number | null }> | null;
}>;

export type WorkPackage = Readonly<{
  id: string;
  /**
   * `bench` is the package being prepared right now. `dispatched` is a package
   * that already left for a printer, one per printer checkoff link.
   */
  kind: "bench" | "dispatched";
  title: string;
  status: WorkPackageStatus;
  statusLabel: string;
  /** One plain line: what this package is and where it is. */
  summary: string;
  unitCount: number;
  completedUnitCount: number;
  plateCount: number;
  links: WorkPackageLinks;
  /** Set when the package cannot move at all, with the reason in plain words. */
  blockedReason: string | null;
}>;

export type WorkPackageProjectionInput = Readonly<{
  profileId: number | null;
  workspace: AcceptedPlateWorkspace | undefined;
  setup: ProductionSetup | undefined;
  selectedTokens: readonly RequiredUnitToken[];
  exportRecords: readonly AcceptedPlateExportRecord[];
  checkoffLinks: readonly PrinterCheckoffLink[];
  /** The sliced file the user has added in this browser session, if any. */
  slicedFile: Readonly<{ name: string }> | null;
  /** The printer chosen for the next send, if any. */
  printer: Readonly<{ id: string; name: string }> | null;
  /** Set when the last export attempt for the current Plate revision failed. */
  exportFailed?: boolean;
}>;

export type WorkPackageProjection = Readonly<{
  /** The package being prepared. Null when there is no accepted Plan to make. */
  bench: WorkPackage | null;
  /** Packages already at a printer or waiting for verification. */
  active: readonly WorkPackage[];
  /** Recently finished packages, newest first. */
  recent: readonly WorkPackage[];
}>;

const TOKEN_PATTERN = /__(ppu_[0-9a-f]{32})$/;

/**
 * Object names carry their Required-unit token, so a sent G-code file can be
 * mapped back to the exact units it covers.
 */
export function requiredUnitTokensFromObjectNames(
  names: readonly (string | undefined)[],
): RequiredUnitToken[] {
  const tokens: RequiredUnitToken[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const match = name ? TOKEN_PATTERN.exec(name) : null;
    if (!match) continue;
    const token = match[1];
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token as RequiredUnitToken);
  }
  return tokens;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The newest finished export whose artifact matches the current Plate revision. */
export function currentExportArtifact(
  records: readonly AcceptedPlateExportRecord[],
  plateRevisionId: number | null,
): WorkPackageLinks["exportArtifact"] {
  if (plateRevisionId == null) return null;
  const matches = records.filter(
    (record) =>
      record.status === "done" &&
      record.result != null &&
      record.result.plate_revision_id === plateRevisionId,
  );
  const newest = matches[matches.length - 1];
  if (!newest?.result) return null;
  return {
    jobId: newest.job_id,
    plateRevisionNumber: newest.result.plate_revision_number,
    plateCount: newest.result.plates.length,
    bundleUrl: newest.result.bundle_download_url,
  };
}

function benchStatus(input: {
  hasPlan: boolean;
  selectedCount: number;
  needsAssignment: boolean;
  needsArrangement: boolean;
  hasExport: boolean;
  hasSlicedFile: boolean;
  exportFailed: boolean;
}): WorkPackageStatus {
  if (!input.hasPlan) return "preparing";
  if (input.exportFailed) return "failed";
  if (input.selectedCount === 0) return "preparing";
  if (input.needsAssignment || input.needsArrangement) return "preparing";
  if (!input.hasExport) return "ready_to_slice";
  if (!input.hasSlicedFile) return "awaiting_sliced_file";
  return "ready_to_send";
}

function benchSummary(status: WorkPackageStatus, unitCount: number, plateCount: number): string {
  switch (status) {
    case "preparing":
      return unitCount === 0
        ? "Choose the Required units you want to make next."
        : `${plural(unitCount, "unit", "units")} chosen. Finish the Plate setup.`;
    case "ready_to_slice":
      return `${plural(unitCount, "unit", "units")} on ${plural(plateCount, "Plate", "Plates")}. Export them for your slicer.`;
    case "awaiting_sliced_file":
      return "Exported. Slice the files, then come back and add the G-code.";
    case "ready_to_send":
      return "The sliced file is ready. Send it or start the print.";
    case "failed":
      return "The last export failed. Retry it below.";
    default:
      return `${plural(unitCount, "unit", "units")} in this package.`;
  }
}

function dispatchedStatus(link: PrinterCheckoffLink): WorkPackageStatus | null {
  switch (link.state) {
    case "watching":
      return link.saw_active || link.started ? "printing" : "queued";
    case "awaiting_verify":
      return "needs_verification";
    case "host_failed":
      return "failed";
    case "verified":
    case "applied":
      return "complete";
    case "dismissed":
      return null;
  }
}

function dispatchedSummary(status: WorkPackageStatus, link: PrinterCheckoffLink, units: number): string {
  const unitLine = units > 0 ? `${plural(units, "unit", "units")} covered` : "No units mapped";
  switch (status) {
    case "queued":
      return `${unitLine}. Sent to ${link.host_name}, waiting for the print to start.`;
    case "printing":
      return `${unitLine}. Printing on ${link.host_name}.`;
    case "needs_verification":
      return `${unitLine}. The print finished. Verify it in Checkoff.`;
    case "failed":
      return `${unitLine}. ${link.host_name} reported a failure. Send it again or verify what survived.`;
    case "complete":
      return `${unitLine}. Verified in Checkoff.`;
    default:
      return unitLine;
  }
}

function dispatchedPackage(link: PrinterCheckoffLink): WorkPackage | null {
  const status = dispatchedStatus(link);
  if (status == null) return null;
  const tokens = requiredUnitTokensFromObjectNames(link.units.map((unit) => unit.object_name));
  const unitCount = link.units.length;
  return {
    id: `send-${link.id}`,
    kind: "dispatched",
    title: link.filename,
    status,
    statusLabel: WORK_PACKAGE_STATUS_LABEL[status],
    summary: dispatchedSummary(status, link, unitCount),
    unitCount,
    completedUnitCount: status === "complete" ? unitCount : (link.units_marked ?? 0),
    plateCount: 0,
    blockedReason: null,
    links: {
      acceptedPlan: null,
      unitTokens: tokens,
      plateRevision: null,
      exportArtifact: null,
      slicedFile: { name: link.filename },
      printer: { id: link.printer_id, name: link.host_name },
      sendJob: { linkId: link.id, filename: link.filename, sentAt: link.created_at },
      verification: {
        route: progressRoute(link.profile_id),
        unitsMarked: link.units_marked ?? null,
      },
    },
  };
}

function sentAtValue(link: PrinterCheckoffLink): string {
  return link.applied_at ?? link.completed_at ?? link.created_at;
}

/**
 * Projects every Production work package for one Build from the records that
 * already exist. Pure: give it the same inputs and it gives the same answer.
 */
export function projectWorkPackages(input: WorkPackageProjectionInput): WorkPackageProjection {
  const workspace = input.workspace;
  const scopedLinks = input.checkoffLinks.filter(
    (link) => input.profileId == null || link.profile_id === input.profileId,
  );
  const dispatched = scopedLinks
    .map(dispatchedPackage)
    .filter((entry): entry is WorkPackage => entry != null);
  const byNewest = (a: WorkPackage, b: WorkPackage) =>
    (b.links.sendJob?.sentAt ?? "").localeCompare(a.links.sendJob?.sentAt ?? "");
  const active = dispatched
    .filter((entry) => entry.status !== "complete")
    .sort(byNewest);
  const recent = dispatched
    .filter((entry) => entry.status === "complete")
    .sort((a, b) => {
      const aLink = scopedLinks.find((link) => `send-${link.id}` === a.id);
      const bLink = scopedLinks.find((link) => `send-${link.id}` === b.id);
      return (bLink ? sentAtValue(bLink) : "").localeCompare(aLink ? sentAtValue(aLink) : "");
    })
    .slice(0, 5);

  if (input.profileId == null || workspace == null || workspace.kind === "empty_plan") {
    return {
      bench: workspace?.kind === "empty_plan"
        ? {
            id: "bench-empty",
            kind: "bench",
            title: "Next work package",
            status: "preparing",
            statusLabel: WORK_PACKAGE_STATUS_LABEL.preparing,
            summary: "This Build has no accepted Required units yet.",
            unitCount: 0,
            completedUnitCount: 0,
            plateCount: 0,
            blockedReason: "Accept a Plan revision with Required units before you prepare work.",
            links: {
              acceptedPlan: null,
              unitTokens: [],
              plateRevision: null,
              exportArtifact: null,
              slicedFile: null,
              printer: null,
              sendJob: null,
              verification: null,
            },
          }
        : null,
      active,
      recent,
    };
  }

  const ready = workspace.kind === "ready" ? workspace : null;
  const setup = workspace.kind === "setup" ? workspace : null;
  const selected = new Set<string>(input.selectedTokens);
  const allUnits: readonly ProductionSelectableUnit[] = ready
    ? [...ready.plates.flatMap((plate) => plate.units), ...ready.unplaced, ...ready.unassigned]
    : (setup?.units ?? []);
  const packageUnits = allUnits.filter((unit) => selected.has(unit.token));
  const plateRevision = ready
    ? { id: ready.plate_revision_id, number: ready.plate_revision_number }
    : null;
  const exportArtifact = currentExportArtifact(input.exportRecords, plateRevision?.id ?? null);
  const needsAssignment = setup != null || (ready?.unassigned.length ?? 0) > 0;
  const needsArrangement = (ready?.unplaced.length ?? 0) > 0;
  const status = benchStatus({
    hasPlan: true,
    selectedCount: packageUnits.length,
    needsAssignment,
    needsArrangement,
    hasExport: exportArtifact != null,
    hasSlicedFile: input.slicedFile != null,
    exportFailed: input.exportFailed === true,
  });
  const plateCount = ready
    ? ready.plates.filter((plate) =>
        plate.units.some((unit) => selected.has(unit.token)),
      ).length
    : 0;

  const bench: WorkPackage = {
    id: plateRevision
      ? `bench-plate-${plateRevision.id}`
      : `bench-plan-${(ready ?? setup)?.basis.plan_revision_id ?? 0}`,
    kind: "bench",
    title: "Next work package",
    status,
    statusLabel: WORK_PACKAGE_STATUS_LABEL[status],
    summary: benchSummary(status, packageUnits.length, plateCount),
    unitCount: packageUnits.length,
    completedUnitCount: packageUnits.filter((unit) => unit.completed).length,
    plateCount,
    blockedReason: null,
    links: {
      acceptedPlan: {
        revisionId: (ready ?? setup)?.basis.plan_revision_id ?? 0,
        version: (ready ?? setup)?.basis.plan_version ?? 0,
      },
      unitTokens: packageUnits.map((unit) => unit.token),
      plateRevision,
      exportArtifact,
      slicedFile: input.slicedFile,
      printer: input.printer,
      sendJob: null,
      verification: null,
    },
  };

  return { bench, active, recent };
}

import type {
  AcceptedPlateExportRecord,
  AcceptedPlateWorkspace,
  ProductionPrinterAssignment,
  ProductionRoute,
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
  /** Unit files are available. The `stl` route's resting state. */
  | "ready_to_download"
  | "queued"
  | "printing"
  | "needs_verification"
  | "failed"
  | "complete";

export const WORK_PACKAGE_STATUS_LABEL: Record<WorkPackageStatus, string> = {
  preparing: "Preparing",
  ready_to_slice: "Ready to slice",
  awaiting_sliced_file: "Awaiting sliced file",
  ready_to_download: "Ready to download",
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
  ready_to_download: "info",
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
  ready_to_download: "Waiting for you",
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
  /**
   * How this package turns Required units into physical results. Null on the
   * bench package until the operator answers the route question; always null on
   * a dispatched package, whose route is settled history.
   */
  route: ProductionRoute | null;
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
  /**
   * True once a file for this Build reached a printer. The result is physical
   * from that moment, so the route stops being changeable and Checkoff owns
   * what happens next. The route is Build state rather than per-package state,
   * which is why one send fixes it for the Build.
   */
  routeLocked: boolean;
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

/**
 * Each route reaches its resting state a different way, so each derives its own
 * status. They are not three lengths of one ladder, and a new route in the
 * contract fails to compile until it says where it rests.
 */
type BenchStatusInput = Readonly<{
  route: ProductionRoute | null;
  hasPlan: boolean;
  selectedCount: number;
  needsAssignment: boolean;
  needsArrangement: boolean;
  hasExport: boolean;
  hasSlicedFile: boolean;
  exportFailed: boolean;
}>;

function benchStatus(input: BenchStatusInput): WorkPackageStatus {
  switch (input.route) {
    case null:
      // No route means no ladder yet. The page shows the question, not a status
      // that would imply work is under way.
      return "preparing";
    case "plates":
      if (!input.hasPlan) return "preparing";
      if (input.exportFailed) return "failed";
      if (input.selectedCount === 0) return "preparing";
      if (input.needsAssignment || input.needsArrangement) return "preparing";
      if (!input.hasExport) return "ready_to_slice";
      if (!input.hasSlicedFile) return "awaiting_sliced_file";
      return "ready_to_send";
    case "stl":
      // `ready_to_download` is where this route rests, and it never advances.
      // `currentExportArtifact` only recognises accepted-Plate 3MF jobs, so an
      // STL pack is invisible to the projection, and even a visible one would
      // not mean much: the files can be taken again at any time and
      // PrintPartner never sees the printer they reach. Reporting
      // `awaiting_sliced_file` here would wait forever for a slicer nobody
      // asked for, and reporting `complete` would claim knowledge the product
      // does not have. Verification is Checkoff's job, and the summary says so.
      if (!input.hasPlan || input.selectedCount === 0) return "preparing";
      return "ready_to_download";
    case "external":
      // Recording a print is data entry, and a confirmed record leaves the
      // bench immediately: it becomes a dispatched package with a real printer
      // status of its own. So the bench package for this route is always the
      // blank form.
      return "preparing";
    default: {
      const _exhaustive: never = input.route;
      return _exhaustive;
    }
  }
}

function platesSummary(status: WorkPackageStatus, unitCount: number, plateCount: number): string {
  switch (status) {
    case "preparing":
      return unitCount === 0
        ? "Choose the parts you want to print next."
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

function benchSummary(input: {
  route: ProductionRoute | null;
  status: WorkPackageStatus;
  unitCount: number;
  plateCount: number;
  recordedPrintCount: number;
}): string {
  switch (input.route) {
    case null:
      return "Choose how you want to print these parts.";
    case "plates":
      return platesSummary(input.status, input.unitCount, input.plateCount);
    case "stl":
      return input.unitCount === 0
        ? "Choose the parts you want to download."
        : `${plural(input.unitCount, "unit", "units")} ready to download. PrintPartner cannot see what you print from these files, so record the result in Checkoff.`;
    case "external":
      return input.recordedPrintCount === 0
        ? "Record a print you already made. Pick the file, then choose the parts it contains."
        : `${plural(input.recordedPrintCount, "print", "prints")} recorded. Verify them in Checkoff, or record another.`;
    default: {
      const _exhaustive: never = input.route;
      return _exhaustive;
    }
  }
}

export type ProductionRouteChange = Readonly<{
  from: ProductionRoute;
  to: ProductionRoute;
  /**
   * Work that stops belonging to this work package, in the operator's words.
   * Nothing listed here is deleted. See `productionRouteChange`.
   */
  setAside: readonly string[];
  /** What the switch does not touch at all. */
  kept: readonly string[];
  /** True when there is work worth warning about, so the switch needs an answer. */
  confirm: boolean;
}>;

/**
 * What a route switch actually does.
 *
 * WCAG 2.2 SC 3.3.4 lets a page that modifies or deletes stored data satisfy
 * the criterion three ways: reversible, checked, or confirmed. This switch is
 * both reversible and confirmed.
 *
 * Reversible is the important part, and it is a correction to
 * docs/audits/2026-08-28-production-route-choice-research.md, which assumed a
 * switch away from the Plates route destroys the Plate work and wrote its
 * confirmation as "This work package will lose". It does not. A Plate revision
 * is its own record keyed to the accepted Plan revision, printer assignments
 * live in the production setup, and an export artifact is a finished job. The
 * route is one field beside them. Switching to `stl` and back leaves every one
 * of those intact, which was checked against a running server.
 *
 * So this names the work that leaves the work package and says plainly that
 * nothing is deleted, rather than deleting the operator's arrangement to make a
 * warning come true. Confirmed still applies: the operator answers before the
 * route moves, which is technique G168 minus the destruction.
 *
 * Required-unit selection is the same answer on every route, so it is never
 * touched, which is what SC 3.3.7 Redundant Entry asks for.
 */
export function productionRouteChange(input: {
  pkg: WorkPackage;
  from: ProductionRoute;
  to: ProductionRoute;
  printerAssignments: readonly ProductionPrinterAssignment[];
}): ProductionRouteChange {
  const links = input.pkg.links;
  const setAside: string[] = [];
  const kept: string[] = [];

  // Only the Plates route builds anything a switch leaves behind. A download is
  // repeatable, and a confirmed print record already belongs to Checkoff.
  if (input.from === "plates") {
    if (links.plateRevision) {
      setAside.push(
        `Plate revision ${links.plateRevision.number}, ${plural(input.pkg.plateCount, "Plate", "Plates")}`,
      );
    }
    const covered = new Set<string>(links.unitTokens);
    const assigned = input.printerAssignments.filter((entry) => covered.has(entry.token)).length;
    if (assigned > 0) {
      setAside.push(
        `Printer assignments for ${plural(assigned, "Required unit", "Required units")}`,
      );
    }
    if (links.exportArtifact) {
      setAside.push(
        plural(links.exportArtifact.plateCount, "exported 3MF file", "exported 3MF files"),
      );
    }
  }

  if (input.pkg.unitCount > 0) {
    kept.push(`Your ${plural(input.pkg.unitCount, "chosen Required unit", "chosen Required units")}`);
  }

  return { from: input.from, to: input.to, setAside, kept, confirm: setAside.length > 0 };
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
    route: null,
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
  const route = input.setup?.route ?? null;
  const routeLocked = dispatched.length > 0;

  if (input.profileId == null || workspace == null || workspace.kind === "empty_plan") {
    return {
      bench: workspace?.kind === "empty_plan"
        ? {
            id: "bench-empty",
            kind: "bench",
            route,
            title: "Next work package",
            status: "preparing",
            statusLabel: WORK_PACKAGE_STATUS_LABEL.preparing,
            summary: "No parts chosen yet.",
            unitCount: 0,
            completedUnitCount: 0,
            plateCount: 0,
            blockedReason: "Choose the parts to print on Plan before preparing work.",
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
      routeLocked,
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
    route,
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
    route,
    title: "Next work package",
    status,
    statusLabel: WORK_PACKAGE_STATUS_LABEL[status],
    summary: benchSummary({
      route,
      status,
      unitCount: packageUnits.length,
      plateCount,
      recordedPrintCount: dispatched.length,
    }),
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

  return { bench, active, recent, routeLocked };
}

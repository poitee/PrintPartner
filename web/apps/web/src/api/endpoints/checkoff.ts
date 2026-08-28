import type {
  PrinterCheckoffLink,
  PrinterCheckoffLinkState,
  PrinterCheckoffReconcileUpdate,
  PrinterCheckoffUnit,
  PrinterHostStatus,
  PrintFileClassification,
  PrintOutcomeEvent,
  PrintOutcomesSummary,
  PrintVerifyDecision,
  ReviewPart,
  UnattributedPrint,
} from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

/**
 * The printer-checkoff wire types live in `@print-partner/contracts`, which the
 * server builds against too. They are re-exported here so the many call sites
 * that already import them from this module keep one import path, and so no
 * second copy can drift away from the server's shape.
 */
export type {
  PrinterCheckoffLink,
  PrinterCheckoffLinkState,
  PrinterCheckoffReconcileUpdate,
  PrinterCheckoffUnit,
  PrinterHostOutcome,
  PrintFileClassification,
  PrintOutcomeEvent,
  PrintOutcomeResult,
  PrintOutcomesSummary,
  PrintRejectReason,
  PrintVerifyDecision,
} from "@print-partner/contracts";

/** @deprecated Prefer PrinterCheckoffReconcileUpdate */
export type PrinterCheckoffApplied = {
  link_id: string;
  host_name: string;
  profile_id: number;
  units_marked: number;
  filename: string;
};

/** @deprecated Use ReviewPart — checkoff data is merged into plan review. */
export type CheckoffPart = Pick<
  ReviewPart,
  | "id"
  | "filename"
  | "match_key"
  | "relative_path"
  | "source_layer"
  | "role"
  | "quantity_effective"
  | "printed_count"
  | "print_units"
  | "missing"
  | "filament_display"
  | "filament_hex"
>;

export async function reconcilePrinterCheckoff(options: {
  integration_id: string;
}): Promise<{
  status: PrinterHostStatus;
  updates: PrinterCheckoffReconcileUpdate[];
  created_links: PrinterCheckoffLink[];
  applied: PrinterCheckoffApplied[];
}> {
  return engineFetch(`/printer-checkoff/reconcile`, {
    method: "POST",
    body: JSON.stringify({
      integration_id: options.integration_id,
    }),
  });
}

export async function fetchPrinterCheckoffLinks(options?: {
  state?: PrinterCheckoffLinkState;
  profile_id?: number;
  integration_id?: string;
}): Promise<{ links: PrinterCheckoffLink[] }> {
  const params = new URLSearchParams();
  if (options?.state) params.set("state", options.state);
  if (options?.profile_id != null) params.set("profile_id", String(options.profile_id));
  if (options?.integration_id) params.set("integration_id", options.integration_id);
  const qs = params.toString();
  return engineFetch(`/printer-checkoff${qs ? `?${qs}` : ""}`);
}

export async function verifyPrinterCheckoff(options: {
  link_id: string;
  decisions: PrintVerifyDecision[];
}): Promise<{
  link: PrinterCheckoffLink;
  units_confirmed: number;
  units_rejected: number;
  outcomes: PrintOutcomeEvent[];
}> {
  return engineFetch(`/printer-checkoff/verify`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function dismissPrinterCheckoff(options: {
  link_id: string;
}): Promise<{ link: PrinterCheckoffLink }> {
  return engineFetch(`/printer-checkoff/dismiss`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function fetchPrintOutcomesSummary(profileId: number): Promise<PrintOutcomesSummary> {
  return engineFetch(`/printer-outcomes/summary?profile_id=${encodeURIComponent(String(profileId))}`);
}

export async function fetchCheckoff(profileId: number): Promise<{
  summary: string;
  parts: CheckoffPart[];
}> {
  return engineFetch(`/plans/${profileId}/checkoff`);
}

export async function patchPartProgress(
  partId: number,
  unitIndex: number,
  completed: boolean,
): Promise<{
  printed_count: number;
  print_units: boolean[];
  /** Post-toggle assembly state — un-printing a unit clears its assembled flag. */
  assembled_units?: boolean[];
  missing: boolean;
}> {
  return engineFetch(`/parts/${partId}/progress`, {
    method: "PATCH",
    body: JSON.stringify({ unit_index: unitIndex, completed }),
  });
}

export async function patchPartAssembled(
  partId: number,
  unitIndex: number,
  assembled: boolean,
): Promise<{
  assembled_count: number;
  assembled_units: boolean[];
}> {
  return engineFetch(`/parts/${partId}/assembled`, {
    method: "PATCH",
    body: JSON.stringify({ unit_index: unitIndex, assembled }),
  });
}

/** Read the per-unit assembled state of a single part. */
export async function fetchPartAssembled(partId: number): Promise<{
  part_id: number;
  assembled_count: number;
  assembled_units: boolean[];
}> {
  return engineFetch(`/parts/${partId}/assembled`);
}

export async function fetchUnattributedPrints(): Promise<UnattributedPrint[]> {
  const res = await engineFetch<{ prints: UnattributedPrint[] }>("/printer-checkoff/unattributed");
  return res.prints;
}

export async function claimUnattributedPrint(
  id: string,
  profile_id: number,
  options?: { selected_stl_basenames?: string[] },
): Promise<{ ok: boolean; link: PrinterCheckoffLink }> {
  return engineFetch(`/printer-checkoff/unattributed/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    body: JSON.stringify({ profile_id, ...options }),
  });
}

export async function dismissUnattributedPrint(id: string): Promise<void> {
  await engineFetch(`/printer-checkoff/unattributed/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
    body: "{}",
  });
}

/** The parts of a print file check that do not depend on reading the bytes. */
type PrintFileCheckBasis = {
  /** Required units the file's object names or filename point at. */
  suggested_units: PrinterCheckoffUnit[];
  /** What the suggestion was drawn from, so the operator can judge it. */
  suggestion_basis: "object_names" | "filename" | "none";
  /** Object names that matched no Required unit. */
  unlabeled_names: string[];
  /** The Accepted Plan revision the assignment will be pinned to. */
  plan_revision_id: number;
};

/**
 * What PrintPartner learned about a print file before anything was written.
 *
 * Two arms, not one bag with optional fields. The server can only classify a
 * file whose bytes it can fetch, and a file it never read has no
 * classification at all rather than an unknown one. Making `inspected` the
 * discriminant puts `classification` out of reach in the arm where it does not
 * exist, so the UI cannot render a guess as a fact.
 */
export type PrintFileAssignmentPreview =
  | (PrintFileCheckBasis & {
      inspected: true;
      classification: PrintFileClassification;
      print_ready: boolean;
    })
  | (PrintFileCheckBasis & { inspected: false });

function readClassification(value: unknown): PrintFileClassification | null {
  if (typeof value !== "object" || value === null || !("format" in value)) return null;
  if (value.format === "gcode" || value.format === "bgcode") return { format: value.format };
  if (value.format !== "3mf" || !("kind" in value)) return null;
  const kind = value.kind;
  return kind === "slicer_project" ||
    kind === "model_package" ||
    kind === "toolpath_package" ||
    kind === "unsupported"
    ? { format: "3mf", kind }
    : null;
}

function readSuggestedUnits(value: unknown): PrinterCheckoffUnit[] | null {
  if (!Array.isArray(value)) return null;
  const units: PrinterCheckoffUnit[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    if (!("part_id" in entry) || !("unit_index" in entry)) return null;
    const partId = entry.part_id;
    const unitIndex = entry.unit_index;
    if (typeof partId !== "number" || !Number.isInteger(partId)) return null;
    if (typeof unitIndex !== "number" || !Number.isInteger(unitIndex)) return null;
    const objectName = "object_name" in entry ? entry.object_name : undefined;
    units.push({
      part_id: partId,
      unit_index: unitIndex,
      ...(typeof objectName === "string" ? { object_name: objectName } : {}),
    });
  }
  return units;
}

function readNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((name) => typeof name === "string") ? [...value] : null;
}

/**
 * Narrow the preview reply before the UI switches on it.
 *
 * The classification and the suggestion basis both drive exhaustive switches
 * whose default arm is `never`, so a server that answers a shape this client
 * does not know has to become a failure the operator can retry, not a crashed
 * sheet. `@print-partner/contracts` owns the schema validator, and this app does
 * not depend on it directly, so the fields this UI branches on are checked here.
 *
 * The two arms are kept apart on purpose: an `inspected` reply missing its
 * classification, and an uninspected reply carrying one, are both rejected
 * rather than quietly averaged into something the UI would render as fact.
 */
export function parsePrintFileAssignmentPreview(value: unknown): PrintFileAssignmentPreview {
  const unreadable = new Error(
    "The server answered the print file check in a shape this app cannot read.",
  );
  if (typeof value !== "object" || value === null) throw unreadable;
  if (
    !("inspected" in value) ||
    !("suggested_units" in value) ||
    !("suggestion_basis" in value) ||
    !("unlabeled_names" in value) ||
    !("plan_revision_id" in value)
  ) {
    throw unreadable;
  }
  const suggestedUnits = readSuggestedUnits(value.suggested_units);
  const unlabeledNames = readNames(value.unlabeled_names);
  const basis = value.suggestion_basis;
  const revisionId = value.plan_revision_id;
  if (
    suggestedUnits === null ||
    unlabeledNames === null ||
    typeof revisionId !== "number" ||
    !Number.isInteger(revisionId) ||
    (basis !== "object_names" && basis !== "filename" && basis !== "none")
  ) {
    throw unreadable;
  }
  const basisFields: PrintFileCheckBasis = {
    suggested_units: suggestedUnits,
    suggestion_basis: basis,
    unlabeled_names: unlabeledNames,
    plan_revision_id: revisionId,
  };

  if (value.inspected === false) {
    if ("classification" in value || "print_ready" in value) throw unreadable;
    return { ...basisFields, inspected: false };
  }
  if (value.inspected !== true) throw unreadable;
  if (!("classification" in value) || !("print_ready" in value)) throw unreadable;
  const classification = readClassification(value.classification);
  if (classification === null || typeof value.print_ready !== "boolean") throw unreadable;
  return {
    ...basisFields,
    inspected: true,
    classification,
    print_ready: value.print_ready,
  };
}

/**
 * Inspect a print file and propose a mapping. Writes nothing, so the operator
 * can look at the classification and the suggested units before committing.
 */
export async function previewPrinterFileAssignment(options: {
  profile_id: number;
  printer_id: string;
  filename: string;
  remote_path?: string;
  object_names: string[];
}): Promise<PrintFileAssignmentPreview> {
  return parsePrintFileAssignmentPreview(
    await engineFetch<unknown>("/printer-checkoff/file-assignments/preview", {
      method: "POST",
      body: JSON.stringify(options),
    }),
  );
}

/**
 * Commit the mapping the operator confirmed.
 *
 * `plan_revision_id` comes from the preview, so the link is pinned to the
 * Accepted Plan revision the operator was actually looking at. `unit_tokens`
 * are `${part_id}:${unit_index}` and may be empty when nothing maps yet.
 */
export async function assignPrinterFile(options: {
  profile_id: number;
  printer_id: string;
  filename: string;
  remote_path?: string;
  object_names: string[];
  tracking: "host" | "manual";
  completed: boolean;
  plan_revision_id: number;
  unit_tokens: string[];
}): Promise<{ link: PrinterCheckoffLink }> {
  return engineFetch("/printer-checkoff/file-assignments", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function completeManualPrinterFile(
  linkId: string,
): Promise<{ link: PrinterCheckoffLink }> {
  return engineFetch(
    `/printer-checkoff/${encodeURIComponent(linkId)}/manual-complete`,
    { method: "POST", body: "{}" },
  );
}

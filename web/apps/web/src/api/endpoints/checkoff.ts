import type { PrinterHostStatus, ReviewPart, UnattributedPrint } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export type PrinterCheckoffUnit = {
  part_id: number;
  unit_index: number;
  object_name?: string;
};

export type PrinterHostOutcome = "unknown" | "success" | "failed" | "cancelled";

export type PrinterCheckoffLinkState =
  | "watching"
  | "awaiting_verify"
  | "host_failed"
  | "dismissed"
  | "verified"
  | "applied";

export type PrintRejectReason =
  | "bed_adhesion"
  | "layer_shift"
  | "warping"
  | "stringing"
  | "under_extrusion"
  | "over_extrusion"
  | "dimensional"
  | "collision"
  | "wrong_filament"
  | "other";

export type PrintOutcomeResult = "confirmed" | "rejected";

export type PrintVerifyDecision = {
  part_id: number;
  unit_index: number;
  result: PrintOutcomeResult;
  reason?: PrintRejectReason;
  note?: string;
};

export type PrintOutcomeEvent = {
  id: string;
  at: string;
  profile_id: number;
  part_id: number;
  unit_index: number;
  result: PrintOutcomeResult;
  reason?: PrintRejectReason;
  note?: string;
  host_integration_id?: string;
  filename?: string;
  match_key?: string;
  role?: string;
  filament_display?: string;
  link_id?: string;
};

export type PrintOutcomesSummary = {
  profile_id: number;
  total_confirmed: number;
  total_rejected: number;
  by_reason: Partial<Record<PrintRejectReason, number>>;
  by_role: Record<string, { confirmed: number; rejected: number }>;
  recent_rejected: PrintOutcomeEvent[];
};

export type PrinterCheckoffLink = {
  id: string;
  profile_id: number;
  integration_id: string;
  printer_id: string;
  host_name: string;
  filename: string;
  remote_path?: string;
  upload_job_id?: string;
  units: PrinterCheckoffUnit[];
  /** Parsed object names that did not map — visible on Progress, never in confirm set. */
  unlabeled_names?: string[];
  resolved_units?: PrintVerifyDecision[];
  state: PrinterCheckoffLinkState;
  host_outcome?: PrinterHostOutcome;
  saw_active: boolean;
  started?: boolean;
  last_progress?: number;
  created_at: string;
  completed_at?: string;
  applied_at?: string;
  units_marked?: number;
};

export type PrinterCheckoffReconcileUpdate = {
  link_id: string;
  host_name: string;
  profile_id: number;
  filename: string;
  event: "awaiting_verify" | "host_failed";
  host_outcome: PrinterHostOutcome;
  units_pending: number;
};

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

export async function assignPrinterFile(options: {
  profile_id: number;
  printer_id: string;
  filename: string;
  remote_path?: string;
  object_names: string[];
  tracking: "host" | "manual";
  completed: boolean;
  sliced_3mf_confirmed?: boolean;
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

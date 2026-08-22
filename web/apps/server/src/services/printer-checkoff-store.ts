import { randomUUID } from "node:crypto";
import type {
  PrinterCheckoffLink,
  PrinterCheckoffLinkState,
  PrinterCheckoffUnit,
  PrinterHostOutcome,
  PrintVerifyDecision,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

const SETTINGS_KEY = "printer.checkoff_links";
const MAX_LINKS = 200;

const LINK_STATES = new Set<PrinterCheckoffLinkState>([
  "watching",
  "awaiting_verify",
  "host_failed",
  "dismissed",
  "verified",
  "applied",
]);

const HOST_OUTCOMES = new Set<PrinterHostOutcome>([
  "unknown",
  "success",
  "failed",
  "cancelled",
]);

export type CreatePrinterCheckoffLinkInput = {
  profile_id: number;
  integration_id: string;
  printer_id: string;
  host_name: string;
  filename: string;
  remote_path?: string;
  upload_job_id?: string;
  units: PrinterCheckoffUnit[];
  /** Object names that did not map to units — preview only, never confirmable. */
  unlabeled_names?: string[];
  /** Upload & start — allow complete with cleared filename before first poll. */
  started?: boolean;
};

function normalizeUnit(x: unknown): PrinterCheckoffUnit | null {
  if (!x || typeof x !== "object") return null;
  const row = x as Record<string, unknown>;
  const partId = Number(row.part_id);
  const unitIndex = Number(row.unit_index);
  if (!Number.isInteger(partId) || partId <= 0) return null;
  if (!Number.isInteger(unitIndex) || unitIndex < 0) return null;
  const unit: PrinterCheckoffUnit = { part_id: partId, unit_index: unitIndex };
  const objectName = typeof row.object_name === "string" ? row.object_name.trim() : "";
  if (objectName) unit.object_name = objectName.slice(0, 200);
  return unit;
}

function parseResolved(raw: unknown): PrintVerifyDecision[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PrintVerifyDecision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const partId = Number(row.part_id);
    const unitIndex = Number(row.unit_index);
    if (!Number.isInteger(partId) || partId <= 0) continue;
    if (!Number.isInteger(unitIndex) || unitIndex < 0) continue;
    const result = row.result;
    if (result !== "confirmed" && result !== "rejected") continue;
    const decision: PrintVerifyDecision = {
      part_id: partId,
      unit_index: unitIndex,
      result,
    };
    if (typeof row.reason === "string") {
      decision.reason = row.reason as PrintVerifyDecision["reason"];
    }
    if (typeof row.note === "string" && row.note.trim()) {
      decision.note = row.note.trim().slice(0, 500);
    }
    out.push(decision);
  }
  return out.length ? out : undefined;
}

function normalizeState(state: PrinterCheckoffLinkState): PrinterCheckoffLinkState {
  // Legacy auto-tick links behave as fully verified.
  if (state === "applied") return "verified";
  return state;
}

function parseLink(raw: unknown): PrinterCheckoffLink | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const rawState = row.state;
  if (typeof rawState !== "string" || !LINK_STATES.has(rawState as PrinterCheckoffLinkState)) {
    return null;
  }
  const state = normalizeState(rawState as PrinterCheckoffLinkState);
  const units = Array.isArray(row.units)
    ? row.units.flatMap((item) => {
        const unit = normalizeUnit(item);
        return unit ? [unit] : [];
      })
    : [];
  const unlabeled_names = Array.isArray(row.unlabeled_names)
    ? row.unlabeled_names
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
        .map((n) => n.trim().slice(0, 200))
        .slice(0, 200)
    : undefined;
  // Plan-only links (empty units / unlabeled) stay loadable so Printers farm can
  // show the bound plan after Send. Unlabeled-only links stay loadable for Progress.
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const integrationId =
    typeof row.integration_id === "string" ? row.integration_id.trim() : "";
  const printerId = typeof row.printer_id === "string" ? row.printer_id.trim() : "";
  const filename = typeof row.filename === "string" ? row.filename.trim() : "";
  const profileId = Number(row.profile_id);
  if (!id || !integrationId || !printerId || !filename || !Number.isInteger(profileId) || profileId <= 0) {
    return null;
  }
  const hostOutcomeRaw = row.host_outcome;
  const host_outcome =
    typeof hostOutcomeRaw === "string" && HOST_OUTCOMES.has(hostOutcomeRaw as PrinterHostOutcome)
      ? (hostOutcomeRaw as PrinterHostOutcome)
      : state === "verified" || state === "awaiting_verify"
        ? "success"
        : state === "host_failed"
          ? "failed"
          : undefined;

  return {
    id,
    profile_id: profileId,
    integration_id: integrationId,
    printer_id: printerId,
    host_name:
      typeof row.host_name === "string" && row.host_name.trim()
        ? row.host_name.trim()
        : "Printer",
    filename,
    remote_path:
      typeof row.remote_path === "string" && row.remote_path.trim()
        ? row.remote_path.trim()
        : undefined,
    upload_job_id:
      typeof row.upload_job_id === "string" && row.upload_job_id.trim()
        ? row.upload_job_id.trim()
        : undefined,
    units,
    unlabeled_names: unlabeled_names?.length ? unlabeled_names : undefined,
    resolved_units: parseResolved(row.resolved_units),
    state,
    host_outcome,
    saw_active: Boolean(row.saw_active),
    started: Boolean(row.started),
    last_progress:
      typeof row.last_progress === "number" && Number.isFinite(row.last_progress)
        ? Math.round(Math.min(100, Math.max(0, row.last_progress)))
        : undefined,
    created_at:
      typeof row.created_at === "string" && row.created_at
        ? row.created_at
        : new Date().toISOString(),
    completed_at:
      typeof row.completed_at === "string" && row.completed_at
        ? row.completed_at
        : typeof row.applied_at === "string" && row.applied_at
          ? row.applied_at
          : undefined,
    applied_at:
      typeof row.applied_at === "string" && row.applied_at ? row.applied_at : undefined,
    units_marked:
      typeof row.units_marked === "number" && Number.isFinite(row.units_marked)
        ? row.units_marked
        : undefined,
  };
}

export function loadPrinterCheckoffLinks(repo: AppRepository): PrinterCheckoffLink[] {
  const raw = repo.getSetting(SETTINGS_KEY);
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseLink).filter((x): x is PrinterCheckoffLink => x != null);
  } catch {
    return [];
  }
}

function savePrinterCheckoffLinks(repo: AppRepository, links: PrinterCheckoffLink[]): void {
  repo.setSetting(SETTINGS_KEY, JSON.stringify(trimPrinterCheckoffLinks(links)));
}

/** Keep active links; prefer dropping oldest terminal history when over cap.
 * Never drop non-terminal (watching / awaiting_verify) links. */
export function trimPrinterCheckoffLinks(links: PrinterCheckoffLink[]): PrinterCheckoffLink[] {
  const terminal = new Set(["verified", "dismissed", "host_failed", "applied"]);
  const active: PrinterCheckoffLink[] = [];
  const done: PrinterCheckoffLink[] = [];
  for (const link of links) {
    if (terminal.has(link.state)) done.push(link);
    else active.push(link);
  }
  const keepDone = Math.max(0, MAX_LINKS - active.length);
  if (keepDone === 0) return active;
  return [...active, ...done.slice(-keepDone)];
}

export function createPrinterCheckoffLink(
  repo: AppRepository,
  input: CreatePrinterCheckoffLinkInput,
): PrinterCheckoffLink | null {
  const units = input.units.flatMap((item) => {
    const unit = normalizeUnit(item);
    return unit ? [unit] : [];
  });
  const unlabeled_names = input.unlabeled_names
    ?.filter((n) => typeof n === "string" && n.trim())
    .map((n) => n.trim().slice(0, 200))
    .slice(0, 200);
  // GRE-232: allow plan-only links (empty units / unlabeled) so Send stamps plan_id
  // even when object parse found nothing. Unlabeled-only Send still works.
  const filename = input.filename.trim();
  const integrationId = input.integration_id.trim();
  const printerId = input.printer_id.trim();
  if (!filename || !integrationId || !printerId) return null;
  if (!Number.isInteger(input.profile_id) || input.profile_id <= 0) return null;

  return repo.transaction(() => {
    const link: PrinterCheckoffLink = {
      id: randomUUID(),
      profile_id: input.profile_id,
      integration_id: integrationId,
      printer_id: printerId,
      host_name: input.host_name.trim() || "Printer",
      filename,
      remote_path: input.remote_path?.trim() || undefined,
      upload_job_id: input.upload_job_id?.trim() || undefined,
      units,
      unlabeled_names,
      state: "watching",
      host_outcome: "unknown",
      saw_active: false,
      started: Boolean(input.started),
      created_at: new Date().toISOString(),
    };
    if (!link.unlabeled_names?.length) delete link.unlabeled_names;
    const all = loadPrinterCheckoffLinks(repo);
    all.push(link);
    savePrinterCheckoffLinks(repo, all);
    return link;
  });
}

export type PrinterCheckoffLinkPatch = Partial<
  Pick<
    PrinterCheckoffLink,
    | "state"
    | "saw_active"
    | "applied_at"
    | "completed_at"
    | "units_marked"
    | "last_progress"
    | "host_outcome"
    | "resolved_units"
    | "units"
    | "unlabeled_names"
  >
>;

export function updatePrinterCheckoffLink(
  repo: AppRepository,
  id: string,
  patch: PrinterCheckoffLinkPatch,
  options?: { requireState?: PrinterCheckoffLinkState | PrinterCheckoffLinkState[] },
): PrinterCheckoffLink | null {
  return repo.transaction(() => {
    const all = loadPrinterCheckoffLinks(repo);
    const idx = all.findIndex((l) => l.id === id);
    if (idx < 0) return null;
    if (options?.requireState) {
      const allowed = Array.isArray(options.requireState)
        ? options.requireState
        : [options.requireState];
      if (!allowed.includes(all[idx].state)) return null;
    }
    const next = { ...all[idx], ...patch };
    // Move patched link to the end so terminal-history trim prefers it.
    all.splice(idx, 1);
    all.push(next);
    savePrinterCheckoffLinks(repo, all);
    return next;
  });
}

export function listWatchingPrinterCheckoffLinks(
  repo: AppRepository,
  integrationId?: string,
): PrinterCheckoffLink[] {
  const id = integrationId?.trim();
  return loadPrinterCheckoffLinks(repo).filter((l) => {
    if (l.state !== "watching") return false;
    if (id && l.integration_id !== id) return false;
    return true;
  });
}

export function listAwaitingVerifyPrinterCheckoffLinks(
  repo: AppRepository,
  profileId?: number,
): PrinterCheckoffLink[] {
  return loadPrinterCheckoffLinks(repo).filter((l) => {
    if (l.state !== "awaiting_verify") return false;
    if (profileId != null && l.profile_id !== profileId) return false;
    return true;
  });
}

export function getPrinterCheckoffLink(
  repo: AppRepository,
  id: string,
): PrinterCheckoffLink | null {
  return loadPrinterCheckoffLinks(repo).find((l) => l.id === id) ?? null;
}

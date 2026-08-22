import { randomUUID } from "node:crypto";
import type { AppRepository } from "../db/repository.js";

export type UnattributedPrint = {
  id: string; // uuid
  integration_id: string;
  printer_id: string;
  host_name: string;
  filename: string; // gcode filename
  completed_at: string; // ISO
  // Object names extracted from EXCLUDE_OBJECT or M486
  gcode_objects: string[]; // raw NAME strings
  // Pre-computed matches against parts library (stlBasename → matching filenames)
  // Populated at creation time, refreshed on demand
  candidates: Array<{
    stl_basename: string;
    copy_count: number;
    matching_filenames: string[]; // filenames found in parts library
  }>;
  // Set once user claims it
  claimed_at?: string;
  claimed_profile_id?: number;
  // Set when dismissed
  dismissed?: boolean;
};

const SETTINGS_KEY = "printer.unattributed_prints";
const MAX_ENTRIES = 100;
const CLAIMED_RETENTION_DAYS = 7;

function loadRaw(repo: AppRepository): UnattributedPrint[] {
  const raw = repo.getSetting(SETTINGS_KEY);
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is UnattributedPrint =>
        x != null &&
        typeof x === "object" &&
        typeof (x as Record<string, unknown>).id === "string" &&
        typeof (x as Record<string, unknown>).filename === "string",
    );
  } catch {
    return [];
  }
}

function saveRaw(repo: AppRepository, prints: UnattributedPrint[]): void {
  repo.setSetting(SETTINGS_KEY, JSON.stringify(prints));
}

function pruneEntries(prints: UnattributedPrint[]): UnattributedPrint[] {
  const now = Date.now();
  const retentionMs = CLAIMED_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Remove dismissed entries and old claimed entries
  const filtered = prints.filter((p) => {
    if (p.dismissed) return false;
    if (p.claimed_at) {
      const claimedAt = new Date(p.claimed_at).getTime();
      if (now - claimedAt > retentionMs) return false;
    }
    return true;
  });

  // If over cap, drop oldest entries (by completed_at)
  if (filtered.length > MAX_ENTRIES) {
    filtered.sort((a, b) => a.completed_at.localeCompare(b.completed_at));
    return filtered.slice(filtered.length - MAX_ENTRIES);
  }
  return filtered;
}

export function listUnattributedPrints(repo: AppRepository): UnattributedPrint[] {
  return pruneEntries(loadRaw(repo));
}

export function listOpenUnattributedPrints(repo: AppRepository): UnattributedPrint[] {
  return listUnattributedPrints(repo).filter((p) => !p.claimed_at && !p.dismissed);
}

export function saveUnattributedPrint(
  repo: AppRepository,
  print: UnattributedPrint,
): void {
  const all = loadRaw(repo);
  // Check for duplicate (same integration + printer + filename + completed_at proximity)
  const existing = all.findIndex((p) => p.id === print.id);
  if (existing >= 0) {
    all[existing] = print;
  } else {
    all.push(print);
  }
  saveRaw(repo, pruneEntries(all));
}

export function claimUnattributedPrint(
  repo: AppRepository,
  id: string,
  profileId: number,
): UnattributedPrint | null {
  const all = loadRaw(repo);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const updated: UnattributedPrint = {
    ...all[idx]!,
    claimed_at: new Date().toISOString(),
    claimed_profile_id: profileId,
  };
  all[idx] = updated;
  saveRaw(repo, pruneEntries(all));
  return updated;
}

export function dismissUnattributedPrint(
  repo: AppRepository,
  id: string,
): boolean {
  const all = loadRaw(repo);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  all[idx] = { ...all[idx]!, dismissed: true };
  saveRaw(repo, pruneEntries(all));
  return true;
}

export function createUnattributedPrint(
  integrationId: string,
  printerId: string,
  hostName: string,
  filename: string,
  gcodeObjects: string[],
  candidates: UnattributedPrint["candidates"],
): UnattributedPrint {
  return {
    id: randomUUID(),
    integration_id: integrationId,
    printer_id: printerId,
    host_name: hostName,
    filename,
    completed_at: new Date().toISOString(),
    gcode_objects: gcodeObjects,
    candidates,
  };
}

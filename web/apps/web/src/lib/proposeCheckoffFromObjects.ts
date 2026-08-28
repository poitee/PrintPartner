/**
 * Propose Progress checkoff units from parsed sliced-object names vs remaining
 * parts. Matching prefers unique Export-remaining names, then shared
 * slicer-aware filename matching. Never auto-ticks Progress.
 */

import type { PrinterCheckoffUnit } from "../api/endpoints/checkoff";
import type { ReviewPart } from "../api/endpoints/planManifests";
import {
  interpretSlicedObjectName,
  matchSlicedObjectName,
} from "@print-partner/domain";
import { incompleteUnitsForParts } from "./printerCheckoffUnits";

export type ProposedObjectMatch = {
  objectName: string;
  part_id: number;
  unit_index: number;
  partFilename: string;
  /** How the name was matched. */
  match: "export_name" | "filename" | "fuzzy";
};

export type ProposeCheckoffResult = {
  /** Units proposed for Progress verify mapping (operator Confirm later). */
  units: PrinterCheckoffUnit[];
  matches: ProposedObjectMatch[];
  /** Parsed names that did not map to a remaining unit. */
  unmatchedNames: string[];
};

/** Preview row for Export / Progress proposal chrome (no checkboxes). */
export type ObjectPreviewRow =
  | {
      kind: "matched";
      part_id: number;
      filename: string;
      quantity: number;
      remaining: number;
      proposedCount: number;
    }
  | {
      kind: "unlabeled";
      name: string;
    };

/** Group matches into mock rows: filename · ×N · M remaining; unmatched → unlabeled. */
export function buildObjectPreviewRows(
  result: ProposeCheckoffResult,
  remainingParts: ReviewPart[],
): ObjectPreviewRow[] {
  const byPart = new Map<number, ProposedObjectMatch[]>();
  for (const m of result.matches) {
    const list = byPart.get(m.part_id) ?? [];
    list.push(m);
    byPart.set(m.part_id, list);
  }
  const rows: ObjectPreviewRow[] = [];
  for (const [partId, list] of byPart) {
    const part = remainingParts.find((p) => p.id === partId);
    const quantity = Math.max(1, part?.quantity_effective ?? list.length);
    const remaining = Math.max(
      0,
      quantity - (part?.printed_count ?? 0),
    );
    rows.push({
      kind: "matched",
      part_id: partId,
      filename: part?.filename ?? list[0]!.partFilename,
      quantity,
      remaining,
      proposedCount: list.length,
    });
  }
  for (const name of result.unmatchedNames) {
    rows.push({ kind: "unlabeled", name });
  }
  return rows;
}

/** Build the same preview rows from a Progress checkoff link's units. */
export function buildPreviewRowsFromUnits(
  units: PrinterCheckoffUnit[],
  parts: ReviewPart[],
  unlabeledNames: string[] = [],
): ObjectPreviewRow[] {
  const byPart = new Map<number, number>();
  for (const u of units) {
    byPart.set(u.part_id, (byPart.get(u.part_id) ?? 0) + 1);
  }
  const rows: ObjectPreviewRow[] = [];
  for (const [partId, proposedCount] of byPart) {
    const part = parts.find((p) => p.id === partId);
    const quantity = Math.max(1, part?.quantity_effective ?? proposedCount);
    const remaining = Math.max(0, quantity - (part?.printed_count ?? 0));
    rows.push({
      kind: "matched",
      part_id: partId,
      filename: part?.filename ?? `Part #${partId}`,
      quantity,
      remaining,
      proposedCount,
    });
  }
  for (const name of unlabeledNames) {
    rows.push({ kind: "unlabeled", name });
  }
  return rows;
}

/** Basename without directory. */
function basename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Strip common mesh/slicer extensions repeatedly. */
export function stripMeshExtensions(name: string): string {
  let s = basename(name).trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/\.(stl|gcode|gco|bgcode|3mf)$/i, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Normalize for comparison: lowercase, strip extensions, drop trailing
 * ` (N)` 3MF copy tags, keep optional `_NN` unit suffix as part of the key.
 */
export function normalizeObjectKey(name: string): string {
  return interpretSlicedObjectName(name).basenameKey;
}

/** Base stem with trailing `_01` / `_1` unit suffix removed. */
export function objectStem(name: string): string {
  return interpretSlicedObjectName(name).unitStemKey;
}

/** Export-remaining style unit filename key: `stem_01` (0-based unit_index → 1-based). */
export function exportUnitKey(filename: string, unitIndex: number): string {
  const stem = normalizeObjectKey(filename);
  const n = String(unitIndex + 1).padStart(2, "0");
  return normalizeObjectKey(`${stem}_${n}`);
}

type RemainingSlot = {
  part: ReviewPart;
  unit_index: number;
  exportKey: string;
};

function remainingSlots(parts: ReviewPart[]): RemainingSlot[] {
  const units = incompleteUnitsForParts(parts);
  return units.map((u) => {
    const part = parts.find((p) => p.id === u.part_id)!;
    return {
      part,
      unit_index: u.unit_index,
      exportKey: exportUnitKey(part.filename, u.unit_index),
    };
  });
}

/**
 * Map parsed object names onto remaining Progress units.
 * Exact export-name matches first; leftover names use the shared path,
 * filename, unit-suffix, and conservative fuzzy policy. Unmatched names are
 * returned, never auto-selected.
 */
export function proposeCheckoffFromObjects(
  objectNames: string[],
  remainingParts: ReviewPart[],
): ProposeCheckoffResult {
  const slots = remainingSlots(remainingParts);
  const used = new Set<string>(); // `${part_id}:${unit_index}`
  const matches: ProposedObjectMatch[] = [];
  const unmatchedNames: string[] = [];

  const takeSlot = (
    slot: RemainingSlot,
    objectName: string,
    match: ProposedObjectMatch["match"],
  ) => {
    const id = `${slot.part.id}:${slot.unit_index}`;
    if (used.has(id)) return false;
    used.add(id);
    matches.push({
      objectName,
      part_id: slot.part.id,
      unit_index: slot.unit_index,
      partFilename: slot.part.filename,
      match,
    });
    return true;
  };

  const pendingStem: string[] = [];

  for (const name of objectNames) {
    const key = normalizeObjectKey(name);
    if (!key) {
      unmatchedNames.push(name);
      continue;
    }
    const exactMatches = slots.filter(
      (s) => !used.has(`${s.part.id}:${s.unit_index}`) && s.exportKey === key,
    );
    if (exactMatches.length === 1 && takeSlot(exactMatches[0]!, name, "export_name")) continue;
    if (exactMatches.length > 1) {
      unmatchedNames.push(name);
      continue;
    }
    pendingStem.push(name);
  }

  for (const name of pendingStem) {
    const available = slots.filter(
      (slot) => !used.has(`${slot.part.id}:${slot.unit_index}`),
    );
    const filenames = [...new Set(available.map((slot) => slot.part.filename))];
    const matched = matchSlicedObjectName(name, filenames);
    if (matched.kind !== "matched") {
      unmatchedNames.push(name);
      continue;
    }
    const candidates = available.filter((slot) => slot.part.filename === matched.filename);
    const partIds = new Set(candidates.map((slot) => slot.part.id));
    if (candidates.length === 0 || partIds.size !== 1) {
      unmatchedNames.push(name);
      continue;
    }
    const matchKind = matched.basis === "fuzzy" ? "fuzzy" : "filename";
    if (!takeSlot(candidates[0]!, name, matchKind)) unmatchedNames.push(name);
  }

  const units: PrinterCheckoffUnit[] = matches.map((m) => {
    const objectName = m.objectName.trim().slice(0, 200);
    return objectName
      ? { part_id: m.part_id, unit_index: m.unit_index, object_name: objectName }
      : { part_id: m.part_id, unit_index: m.unit_index };
  });

  return { units, matches, unmatchedNames };
}

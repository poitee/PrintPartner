/**
 * phaseManifest.ts
 * ----------------
 * Client-side utilities for pp-phases.json phase manifests.
 * A phase manifest groups STL folders into named assembly phases with
 * dependency edges between them. When a plan's source repo contains
 * pp-phases.json, the backend exposes it via GET /plans/:id/phase-manifest
 * and the Progress view switches from a flat parts list to a phase-grouped view.
 */

import type { ReviewPart } from "../api/engine";
import { checkoffUnitTotals, type CheckoffUnitTotals } from "./checkoffProgress";

// ---------------------------------------------------------------------------
// Schema types (mirrors pp-phases.json / build_phases DB row)
// ---------------------------------------------------------------------------

export type PhaseDefinition = {
  name: string;
  order: number;
  description?: string;
  /** Repo-relative folder paths whose STL/3MF files belong to this phase. */
  folders: string[];
  /** Names of phases that must be fully printed before this phase can start. */
  depends_on: string[];
  /** Optional hex color for the phase badge, e.g. '#4A90D9'. */
  color?: string;
};

export type PlanPhaseManifest = {
  profile_id: number;
  /** True when a pp-phases.json was found for at least one source in the plan. */
  has_phases: boolean;
  phases: PhaseDefinition[];
};

// ---------------------------------------------------------------------------
// Per-phase computed progress
// ---------------------------------------------------------------------------

export type PhaseProgress = {
  phase: PhaseDefinition;
  /** Parts in this phase (all, including printed). */
  parts: ReviewPart[];
  totals: CheckoffUnitTotals;
  /** Part count vs qty-effective totals for the header line. */
  partsPrinted: number;
  partsTotal: number;
  /**
   * True when any depends_on phase still has unprinted parts.
   * "Stage blocked" in the spec.
   */
  blocked: boolean;
  /** Names of blocking dependency phases (the ones with missing prints). */
  blockingPhases: string[];
  /** Parts from this phase that are themselves blocking the next unlocked phases. */
  blockingParts: ReviewPart[];
};

// ---------------------------------------------------------------------------
// Assignment helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a repo-relative path to lowercase forward-slash form.
 * "Gantry/XY_Joint.stl" → "gantry/xy_joint.stl"
 */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * Return the phase that owns a given part, or null.
 * First matching phase wins (phases should be sorted by order before calling).
 */
export function phaseForPart(
  part: ReviewPart,
  phases: PhaseDefinition[],
): PhaseDefinition | null {
  const path = normPath(part.relative_path);
  for (const phase of phases) {
    for (const folder of phase.folders) {
      const normFolder = normPath(folder).replace(/\/+$/, "");
      if (path.startsWith(normFolder + "/") || path === normFolder) {
        return phase;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

/**
 * Compute per-phase progress given a manifest and a flat list of included parts.
 * Phases are returned sorted by order ascending; unassigned parts end up in a
 * synthetic "Other" phase at the end (only when there are any).
 */
export function computePhaseProgress(
  manifest: PlanPhaseManifest,
  parts: ReviewPart[],
): PhaseProgress[] {
  const sorted = [...manifest.phases].sort((a, b) => a.order - b.order);

  // Build a map from phase name → parts that belong to it
  const phasePartsMap = new Map<string, ReviewPart[]>(
    sorted.map((ph) => [ph.name, []]),
  );
  const unassigned: ReviewPart[] = [];
  for (const part of parts) {
    const phase = phaseForPart(part, sorted);
    if (phase) {
      phasePartsMap.get(phase.name)!.push(part);
    } else {
      unassigned.push(part);
    }
  }

  // Build an index of which phases are fully printed (for blocked calc)
  const isPhaseMissing = new Map<string, boolean>();
  for (const phase of sorted) {
    const phaseParts = phasePartsMap.get(phase.name)!;
    const hasMissing = phaseParts.some((p) => p.missing);
    isPhaseMissing.set(phase.name, hasMissing);
  }

  const results: PhaseProgress[] = sorted.map((phase) => {
    const phaseParts = phasePartsMap.get(phase.name)!;
    const totals = checkoffUnitTotals(phaseParts);

    const partsTotal = phaseParts.length;
    const partsPrinted = phaseParts.filter((p) => !p.missing).length;

    // A phase is blocked if any dependency phase still has missing prints
    const blockingPhases = phase.depends_on.filter((dep) => isPhaseMissing.get(dep) === true);
    const blocked = blockingPhases.length > 0;

    // Blocking parts = parts in this phase that are missing AND this phase blocks something
    const blockingParts = phaseParts.filter((p) => p.missing);

    return {
      phase,
      parts: phaseParts,
      totals,
      partsPrinted,
      partsTotal,
      blocked,
      blockingPhases,
      blockingParts,
    };
  });

  // Append an "Other" pseudo-phase for unassigned parts
  if (unassigned.length > 0) {
    const totals = checkoffUnitTotals(unassigned);
    results.push({
      phase: {
        name: "Other",
        order: 9999,
        folders: [],
        depends_on: [],
      },
      parts: unassigned,
      totals,
      partsPrinted: unassigned.filter((p) => !p.missing).length,
      partsTotal: unassigned.length,
      blocked: false,
      blockingPhases: [],
      blockingParts: unassigned.filter((p) => p.missing),
    });
  }

  return results;
}

/**
 * Find the "next unlocked phase" — the first non-done phase whose deps are all done.
 * This is used for the "show only blocking parts" quick filter.
 */
export function nextUnlockedPhase(phases: PhaseProgress[]): PhaseProgress | null {
  return phases.find((ph) => !ph.blocked && ph.totals.remainingUnits > 0) ?? null;
}

import type { PlanDecision } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

const MAX_PREFS_CHARS = 2200;
const MAX_DECISIONS = 80;
const MAX_GLOBAL_DECISIONS = 120;
const MAX_PREFER_LINES = 8;
const MAX_AVOID_LINES = 6;
const MAX_NOTE_LINES = 5;
const MAX_GLOBAL_PREFER = 4;
const MAX_GLOBAL_AVOID = 3;

const PATTERN_KEYS = [
  "source_name",
  "preset_id",
  "tag",
  "branch",
  "base_id",
  "layer_id",
  "workflow",
] as const;

/** High-frequency ops that drown Prefer/Avoid unless they are the only signal. */
const NOISE_ACTION_TYPES = new Set(["start_sync", "start_recompute"]);

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n…[truncated]`;
}

/** Sync / recompute / Sync→Update workflow cards — useful as ops, noisy as preferences. */
export function isNoisePreferencePattern(
  actionType: string | null | undefined,
  params: Record<string, unknown> | null | undefined,
): boolean {
  const type = (actionType ?? "").trim();
  if (!type) return false;
  if (NOISE_ACTION_TYPES.has(type)) return true;
  if (type === "apply_build_recipe") {
    const workflow = params?.workflow;
    if (typeof workflow === "string" && workflow.trim() === "sync_then_recompute") {
      return true;
    }
  }
  return false;
}

/** Stable fingerprint for dismiss/avoid matching (action_type + canonical params). */
export function decisionFingerprint(
  actionType: string | null | undefined,
  params: Record<string, unknown> | null | undefined,
): string {
  const type = (actionType ?? "").trim() || "?";
  const p = params && typeof params === "object" ? params : {};
  const parts: string[] = [];
  for (const key of PATTERN_KEYS) {
    const v = p[key];
    if (v == null || v === "") continue;
    parts.push(`${key}=${String(v)}`);
  }
  if (p.selections && typeof p.selections === "object") {
    const sels = Object.entries(p.selections as Record<string, unknown>)
      .map(([k, v]) => `${k}=${String(v)}`)
      .sort();
    if (sels.length) parts.push(`selections={${sels.join(",")}}`);
  }
  parts.sort();
  return `${type}|${parts.join(";")}`;
}

function patternLabel(actionType: string, params: Record<string, unknown>): string {
  const bits: string[] = [actionType];
  for (const key of PATTERN_KEYS) {
    const v = params[key];
    if (v != null && v !== "") bits.push(`${key}=${String(v)}`);
  }
  if (params.selections && typeof params.selections === "object") {
    const keys = Object.keys(params.selections as Record<string, unknown>).slice(0, 6);
    if (keys.length) bits.push(`kit_keys=[${keys.join(",")}]`);
  }
  return bits.join(" ");
}

type PreferEntry = { count: number; label: string; noise: boolean };

function selectPreferEntries(
  appliedCounts: Map<string, PreferEntry>,
  max: number,
): PreferEntry[] {
  const sorted = [...appliedCounts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
  const signal = sorted.filter((e) => !e.noise);
  const source = signal.length > 0 ? signal : sorted;
  return source.slice(0, max);
}

function selectAvoidLabels(
  avoided: Map<string, { label: string; noise: boolean }>,
  max: number,
): string[] {
  const all = [...avoided.values()];
  const signal = all.filter((e) => !e.noise);
  const source = signal.length > 0 ? signal : all;
  return source.slice(0, max).map((e) => e.label);
}

function collectPreferAvoid(list: PlanDecision[]): {
  preferLines: string[];
  avoidLines: string[];
} {
  const appliedCounts = new Map<string, PreferEntry>();
  const avoided = new Map<string, { label: string; noise: boolean }>();

  for (const d of list) {
    if (d.kind === "applied_action" || d.kind === "choice") {
      const fp = decisionFingerprint(d.action_type, d.params);
      const label = patternLabel(d.action_type ?? "choice", d.params ?? {});
      const noise = isNoisePreferencePattern(d.action_type, d.params);
      const prev = appliedCounts.get(fp);
      appliedCounts.set(fp, { count: (prev?.count ?? 0) + 1, label, noise });
    } else if (d.kind === "dismissed_action") {
      const fp = decisionFingerprint(d.action_type, d.params);
      avoided.set(fp, {
        label: patternLabel(d.action_type ?? "action", d.params ?? {}),
        noise: isNoisePreferencePattern(d.action_type, d.params),
      });
    }
  }

  const preferLines = selectPreferEntries(appliedCounts, MAX_PREFER_LINES).map(
    ({ count, label }) => `- Prefer (${count}×): ${label}`,
  );

  const avoidLines = selectAvoidLabels(avoided, MAX_AVOID_LINES).map(
    (label) => `- Avoid re-proposing: ${label}`,
  );

  return { preferLines, avoidLines };
}

function collectNoteLines(list: PlanDecision[]): string[] {
  const notes: string[] = [];
  for (const d of [...list].reverse()) {
    if (notes.length >= MAX_NOTE_LINES) break;
    if (d.kind !== "user_note" && d.kind !== "choice") continue;
    // Choices with action fingerprints already appear under Prefer; keep free-text choices/notes.
    if (d.kind === "choice" && d.action_type) continue;
    const text = (d.summary || d.label || d.rationale || "").trim();
    if (!text) continue;
    const kind = d.kind === "user_note" ? "note" : "choice";
    notes.push(`- [${kind}] ${text.slice(0, 160)}`);
  }
  return notes;
}

function collectGlobalPreferAvoid(
  list: PlanDecision[],
): { preferLines: string[]; avoidLines: string[] } {
  const appliedCounts = new Map<string, PreferEntry>();
  const avoided = new Map<string, { label: string; noise: boolean }>();

  for (const d of list) {
    if (d.kind === "applied_action" || d.kind === "choice") {
      const fp = decisionFingerprint(d.action_type, d.params);
      const label = patternLabel(d.action_type ?? "choice", d.params ?? {});
      const noise = isNoisePreferencePattern(d.action_type, d.params);
      const prev = appliedCounts.get(fp);
      appliedCounts.set(fp, { count: (prev?.count ?? 0) + 1, label, noise });
    } else if (d.kind === "dismissed_action") {
      const fp = decisionFingerprint(d.action_type, d.params);
      avoided.set(fp, {
        label: patternLabel(d.action_type ?? "action", d.params ?? {}),
        noise: isNoisePreferencePattern(d.action_type, d.params),
      });
    }
  }

  // Cross-plan: drop Sync/Update noise when real kit/stack signals exist.
  const preferLines = selectPreferEntries(appliedCounts, MAX_GLOBAL_PREFER).map(
    ({ count, label }) => `- Cross-plan prefer (${count}×): ${label}`,
  );

  const avoidLines = selectAvoidLabels(avoided, MAX_GLOBAL_AVOID).map(
    (label) => `- Cross-plan avoid: ${label}`,
  );

  return { preferLines, avoidLines };
}

export type BuildPreferencesDigestOptions = {
  /** Preloaded plan decisions (tests). */
  decisions?: PlanDecision[];
  /** Preloaded other-plan decisions (tests). */
  globalDecisions?: PlanDecision[];
};

/**
 * Build "## User preferences" from plan_decisions (this plan + cross-plan memory).
 * Prefer repeated applied patterns; list dismissed fingerprints to avoid.
 * Includes recent user_note / free-text choice lines.
 */
export function buildPreferencesDigest(
  repo: AppRepository,
  planId: number | null | undefined,
  options?: BuildPreferencesDigestOptions | PlanDecision[],
): string | null {
  // Back-compat: third arg used to be decisions[].
  const opts: BuildPreferencesDigestOptions = Array.isArray(options)
    ? { decisions: options }
    : (options ?? {});

  const sections: string[] = [];

  if (planId != null && planId > 0) {
    const list = opts.decisions ?? repo.listPlanDecisions(planId, MAX_DECISIONS);
    const { preferLines, avoidLines } = collectPreferAvoid(list);
    const noteLines = collectNoteLines(list);

    if (preferLines.length || avoidLines.length || noteLines.length) {
      sections.push(
        [
          "## User preferences (from this plan)",
          "Learned from Apply/Dismiss/notes on this plan — not training data. Treat Prefer/Avoid as hard guidance; do not re-propose dismissed fingerprints without asking.",
          preferLines.length ? "### Prefer" : null,
          ...preferLines,
          avoidLines.length ? "### Avoid" : null,
          ...avoidLines,
          noteLines.length ? "### Notes & choices" : null,
          ...noteLines,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  const globalList =
    opts.globalDecisions ??
    (typeof repo.listRecentTenantPlanDecisions === "function"
      ? repo.listRecentTenantPlanDecisions(
          MAX_GLOBAL_DECISIONS,
          planId != null && planId > 0 ? planId : null,
        )
      : []);

  if (globalList.length) {
    const { preferLines, avoidLines } = collectGlobalPreferAvoid(globalList);
    if (preferLines.length || avoidLines.length) {
      sections.push(
        [
          "## Cross-plan memory (other builds)",
          "Patterns from other plans in this tenant — context only, not fine-tuning. Prefer these when the user asks for “the same as before” / “like last time”.",
          preferLines.length ? "### Prefer (other plans)" : null,
          ...preferLines,
          avoidLines.length ? "### Avoid (other plans)" : null,
          ...avoidLines,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (!sections.length) return null;
  return truncate(sections.join("\n\n"), MAX_PREFS_CHARS);
}

/** Whether a proposed action matches a dismissed fingerprint on this plan. */
export function isDismissedFingerprint(
  repo: AppRepository,
  planId: number,
  actionType: string,
  params: Record<string, unknown>,
): boolean {
  if (!planId || planId <= 0) return false;
  const fp = decisionFingerprint(actionType, params);
  const decisions = repo.listPlanDecisions(planId, MAX_DECISIONS);
  return decisions.some(
    (d) =>
      d.kind === "dismissed_action" &&
      decisionFingerprint(d.action_type, d.params) === fp,
  );
}

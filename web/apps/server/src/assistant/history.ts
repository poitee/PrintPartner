import { randomUUID } from "node:crypto";
import type {
  AssistantFeedbackRating,
  AssistantHistoryMessage,
  AssistantProposedAction,
} from "@print-partner/contracts";
import { isAssistantUiAction } from "@print-partner/contracts";
import { sanitizeAssistantDisplayText } from "./sanitize-display-text.js";
import type { AppRepository } from "../db/repository.js";

const HISTORY_KEY = "assistant_chat_history";
const FEEDBACK_KEY = "assistant_feedback";
const MAX_HISTORY = 40;
const MAX_FEEDBACK = 200;
/** Cap pending Apply cards stored with a single assistant turn. */
const MAX_PENDING_ACTIONS = 12;

function isProposedAction(value: unknown): value is AssistantProposedAction {
  if (!value || typeof value !== "object") return false;
  const a = value as AssistantProposedAction;
  return (
    typeof a.id === "string" &&
    typeof a.type === "string" &&
    typeof a.plan_id === "number" &&
    typeof a.label === "string" &&
    typeof a.summary === "string" &&
    a.params != null &&
    typeof a.params === "object"
  );
}

function sanitizeProposedActions(
  raw: unknown,
): AssistantProposedAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .filter(isProposedAction)
    .filter((a) => !isAssistantUiAction(a.type))
    .slice(0, MAX_PENDING_ACTIONS);
  return actions.length > 0 ? actions : undefined;
}

function parseHistoryMessage(m: unknown): AssistantHistoryMessage | null {
  if (!m || typeof m !== "object") return null;
  const row = m as AssistantHistoryMessage;
  if (
    typeof row.id !== "string" ||
    typeof row.content !== "string" ||
    (row.role !== "user" && row.role !== "assistant")
  ) {
    return null;
  }
  const proposed = sanitizeProposedActions(row.proposed_actions);
  return {
    id: row.id,
    role: row.role,
    content: sanitizeAssistantDisplayText(row.content),
    created_at: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
    ...(proposed ? { proposed_actions: proposed } : {}),
  };
}

export function loadAssistantHistory(repo: AppRepository): AssistantHistoryMessage[] {
  const raw = repo.getSetting(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseHistoryMessage)
      .filter((m): m is AssistantHistoryMessage => m != null)
      .slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function persistHistory(repo: AppRepository, messages: AssistantHistoryMessage[]): void {
  repo.setSetting(HISTORY_KEY, JSON.stringify(messages.slice(-MAX_HISTORY)));
}

export function appendAssistantHistory(
  repo: AppRepository,
  entries: Array<{
    role: "user" | "assistant";
    content: string;
    proposed_actions?: AssistantProposedAction[];
  }>,
): AssistantHistoryMessage[] {
  const existing = loadAssistantHistory(repo);
  const now = new Date().toISOString();
  for (const e of entries) {
    if (!e.content.trim() && !(e.proposed_actions && e.proposed_actions.length > 0)) continue;
    const proposed =
      e.role === "assistant" ? sanitizeProposedActions(e.proposed_actions) : undefined;
    existing.push({
      id: randomUUID(),
      role: e.role,
      content: sanitizeAssistantDisplayText(e.content).slice(0, 8000),
      created_at: now,
      ...(proposed ? { proposed_actions: proposed } : {}),
    });
  }
  const trimmed = existing.slice(-MAX_HISTORY);
  persistHistory(repo, trimmed);
  return trimmed;
}

/**
 * Remove a pending proposed action from history after Apply or Dismiss.
 * Returns true when an action was removed.
 */
export function removePendingProposedAction(
  repo: AppRepository,
  actionId: string,
): boolean {
  if (!actionId) return false;
  const messages = loadAssistantHistory(repo);
  let changed = false;
  for (const m of messages) {
    if (!m.proposed_actions?.length) continue;
    const next = m.proposed_actions.filter((a) => a.id !== actionId);
    if (next.length !== m.proposed_actions.length) {
      changed = true;
      m.proposed_actions = next.length > 0 ? next : undefined;
    }
  }
  if (changed) persistHistory(repo, messages);
  return changed;
}

/**
 * Attach additional pending Apply cards to the most recent assistant history turn
 * (for example, a post-Apply Source sync).
 */
export function appendPendingProposedActions(
  repo: AppRepository,
  actions: AssistantProposedAction[],
): boolean {
  const clean = sanitizeProposedActions(actions);
  if (!clean?.length) return false;
  const messages = loadAssistantHistory(repo);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const existing = m.proposed_actions ?? [];
    const ids = new Set(existing.map((a) => a.id));
    const merged = [...existing, ...clean.filter((a) => !ids.has(a.id))].slice(
      0,
      MAX_PENDING_ACTIONS,
    );
    m.proposed_actions = merged.length > 0 ? merged : undefined;
    persistHistory(repo, messages);
    return true;
  }
  // No assistant turn yet — store a lightweight stub so reopen still shows the card.
  messages.push({
    id: randomUUID(),
    role: "assistant",
    content: "",
    created_at: new Date().toISOString(),
    proposed_actions: clean,
  });
  persistHistory(repo, messages);
  return true;
}

export function clearAssistantHistory(repo: AppRepository): void {
  repo.setSetting(HISTORY_KEY, JSON.stringify([]));
}

/** Wipe thumbs ratings for this tenant (ranking scores only — not chat history). */
export function clearAssistantFeedback(repo: AppRepository): number {
  const n = loadAssistantFeedback(repo).length;
  repo.setSetting(FEEDBACK_KEY, JSON.stringify([]));
  return n;
}

export type StoredFeedback = {
  id: string;
  rating: AssistantFeedbackRating;
  message_excerpt: string | null;
  plan_id: number | null;
  comment: string | null;
  created_at: string;
};

export function loadAssistantFeedback(repo: AppRepository): StoredFeedback[] {
  const raw = repo.getSetting(FEEDBACK_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as StoredFeedback[]).slice(-MAX_FEEDBACK);
  } catch {
    return [];
  }
}

export function appendAssistantFeedback(
  repo: AppRepository,
  input: {
    rating: AssistantFeedbackRating;
    message_excerpt?: string;
    plan_id?: number;
    comment?: string;
  },
): StoredFeedback {
  const entry: StoredFeedback = {
    id: randomUUID(),
    rating: input.rating,
    message_excerpt: input.message_excerpt?.slice(0, 500) ?? null,
    plan_id: input.plan_id ?? null,
    comment: input.comment?.slice(0, 1000) ?? null,
    created_at: new Date().toISOString(),
  };
  const list = loadAssistantFeedback(repo);
  list.push(entry);
  repo.setSetting(FEEDBACK_KEY, JSON.stringify(list.slice(-MAX_FEEDBACK)));
  return entry;
}

/** Tiny ranking scores from thumbs — never dump raw feedback into the prompt. */
export type FeedbackScores = {
  /** plan_id → net score (up=+2, down=-2 with comment boost) */
  byPlanId: Map<number, number>;
  /** stack preset id / source-like token → net score (from excerpts) */
  byToken: Map<string, number>;
};

const TOKEN_RE = /\b([a-z][a-z0-9_]{2,}(?:\.[a-z0-9_]+)?)\b/gi;
/** Hyphenated source names (Voron-Trident, LDOVoronTrident, etc.). */
const SOURCE_NAME_RE = /\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\b/g;

const THUMBS_PREFER_MIN = 2;
const MAX_THUMBS_PREFER_LINES = 4;

/**
 * Collect catalog tokens worth scoring from thumbs excerpts (presets, bases, source_names).
 */
export function collectCatalogFeedbackTokens(
  catalog: Record<string, unknown> | null | undefined,
): string[] {
  if (!catalog || typeof catalog !== "object") return [];
  const out = new Set<string>();
  const presets = (catalog.stack_presets ?? {}) as Record<string, unknown>;
  for (const id of Object.keys(presets)) {
    if (id.trim()) out.add(id.trim().toLowerCase());
  }
  const bases = (catalog.bases ?? {}) as Record<
    string,
    { source_name?: string }
  >;
  for (const [id, b] of Object.entries(bases)) {
    if (id.trim()) out.add(id.trim().toLowerCase());
    const sn = b?.source_name?.trim();
    if (sn) out.add(sn.toLowerCase());
  }
  const categories = (catalog.addon_categories ?? {}) as Record<
    string,
    { sources?: Array<{ name?: string }> }
  >;
  for (const cat of Object.values(categories)) {
    for (const s of cat.sources ?? []) {
      const n = s.name?.trim();
      if (n) out.add(n.toLowerCase());
    }
  }
  return [...out];
}

/**
 * Aggregate assistant_feedback into small ranking scores for recipes / stacks.
 * Stronger weights: up=+2, down=-2; optional comment adds ±1 when tokens match.
 * Never dumps raw comments into the prompt — scores only.
 */
export function aggregateFeedbackScores(
  repo: AppRepository,
  knownTokens: Iterable<string> = [],
): FeedbackScores {
  const known = new Set(
    [...knownTokens].map((t) => t.toLowerCase()).filter((t) => t.length >= 3),
  );
  const byPlanId = new Map<number, number>();
  const byToken = new Map<string, number>();
  const bump = <K,>(map: Map<K, number>, key: K, delta: number) => {
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  for (const entry of loadAssistantFeedback(repo)) {
    const baseDelta = entry.rating === "up" ? 2 : entry.rating === "down" ? -2 : 0;
    if (!baseDelta) continue;
    if (entry.plan_id != null) bump(byPlanId, entry.plan_id, baseDelta);
    const hay = `${entry.message_excerpt ?? ""} ${entry.comment ?? ""}`;
    if (!hay.trim() || !known.size) continue;
    const commentBoost =
      entry.comment && entry.comment.trim()
        ? entry.rating === "up"
          ? 1
          : -1
        : 0;
    const delta = baseDelta + commentBoost;
    const seen = new Set<string>();
    const consider = (tok: string) => {
      const t = tok.toLowerCase();
      if (!known.has(t) || seen.has(t)) return;
      seen.add(t);
      bump(byToken, t, delta);
    };
    for (const m of hay.matchAll(TOKEN_RE)) {
      consider(m[1] ?? "");
    }
    for (const m of hay.matchAll(SOURCE_NAME_RE)) {
      consider(m[1] ?? "");
    }
    // Exact known-token substring match for multi-word / unusual ids.
    const hayLower = hay.toLowerCase();
    for (const tok of known) {
      if (seen.has(tok)) continue;
      if (hayLower.includes(tok)) consider(tok);
    }
  }
  return { byPlanId, byToken };
}

export function scorePlanFeedback(repo: AppRepository, planId: number): number {
  return aggregateFeedbackScores(repo).byPlanId.get(planId) ?? 0;
}

export function scoreStackPreset(
  repo: AppRepository,
  presetId: string,
  knownPresetIds?: Iterable<string>,
): number {
  const known = knownPresetIds ?? [presetId];
  return aggregateFeedbackScores(repo, known).byToken.get(presetId.toLowerCase()) ?? 0;
}

/**
 * High-confidence thumbs summary for the system prompt (scores only — no free text).
 * Example: `Preferred stacks (thumbs): ldo_trident_r2 (+4)`
 */
export function buildThumbsPreferDigestLine(
  repo: AppRepository,
  knownTokens: Iterable<string> = [],
): string | null {
  const { byToken } = aggregateFeedbackScores(repo, knownTokens);
  const ranked = [...byToken.entries()]
    .filter(([, score]) => score >= THUMBS_PREFER_MIN)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_THUMBS_PREFER_LINES);
  if (!ranked.length) return null;
  const bits = ranked.map(([tok, score]) => `${tok} (+${score})`);
  return `Preferred stacks (thumbs): ${bits.join(", ")}`;
}

/** Simple stable hash of message excerpt for restoring thumbs UI after reload. */
export function feedbackExcerptKey(excerpt: string | null | undefined): string {
  const s = (excerpt ?? "").trim().slice(0, 400);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `ex${h}`;
}

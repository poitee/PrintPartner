import type { AssistantChatMessage, AssistantProposedAction } from "@print-partner/contracts";
import { randomUUID } from "node:crypto";
import { ASSISTANT_TOOL_SPECS, invokeAssistantTool, type ToolContext } from "./tools.js";
import {
  parseTextEmbeddedToolCalls,
  stripEmbeddedToolCallJson,
} from "./parse-text-tool-calls.js";
import { recoverProposedActionsFromText } from "./recover-proposals-from-text.js";
import { suggestSoftStackActions } from "./stack-suggest.js";
import { buildSyncAction } from "./sync-action.js";
import { isDismissedFingerprint } from "./preferences-digest.js";
import { loadKitCatalog } from "../services/kit-catalog.js";
import { type BuildDecision, applyUserConstraintsToDecisions } from "./build-decisions.js";
import { findIdentityForSource, loadAliasEntries } from "./domain-pack.js";
import type {
  AssistantPort,
  AssistantToolCallRequest,
  AssistantToolMessage,
  AssistantTurnResult,
} from "./types.js";

function appendSoftStackSuggestions(
  toolCtx: ToolContext,
  proposedActions: AssistantProposedAction[],
): void {
  if (toolCtx.activePlanId == null) return;
  const soft = suggestSoftStackActions({
    repo: toolCtx.repo,
    planId: toolCtx.activePlanId,
    existingActions: proposedActions,
  });
  if (soft.length) proposedActions.push(...soft);
}

/**
 * If the turn proposed set_base with a tag/branch but no sync action yet,
 * append a Sync card so the user isn't left narrating sync.
 */
export function appendSyncIfNeeded(
  toolCtx: ToolContext,
  proposedActions: AssistantProposedAction[],
): void {
  const planId = toolCtx.activePlanId;
  if (planId == null) return;
  if (proposedActions.some((action) => action.type === "start_sync")) {
    return;
  }
  const setBase = proposedActions.find((a) => a.type === "set_base");
  const stackPreset = proposedActions.find((a) => a.type === "apply_stack_preset");
  if (!setBase && !stackPreset) return;
  const tag = typeof setBase?.params?.tag === "string" ? setBase.params.tag.trim() : "";
  const branch =
    typeof setBase?.params?.branch === "string" ? setBase.params.branch.trim() : "";
  // Stack presets (e.g. ldo_trident_r2) often imply a release tag — always offer Sync.
  if (!stackPreset && !tag && !branch) return;

  const names = new Set<string>();
  for (const a of proposedActions) {
    if (a.type !== "set_base" && a.type !== "add_addon") continue;
    const n = a.params?.source_name;
    if (typeof n === "string" && n.trim()) names.add(n.trim());
  }
  // Prefer the catalog base for stack presets when set_base wasn't also proposed.
  if (stackPreset && names.size === 0) {
    try {
      const catalog = loadKitCatalog() as Record<string, unknown>;
      const presets = catalog.stack_presets as
        | Record<string, { base?: string }>
        | undefined;
      const bases = catalog.bases as Record<string, { source_name?: string }> | undefined;
      const presetId =
        typeof stackPreset.params?.preset_id === "string"
          ? stackPreset.params.preset_id
          : "";
      const baseKey = presetId && presets?.[presetId]?.base;
      const baseName = baseKey ? bases?.[baseKey]?.source_name : undefined;
      if (baseName) names.add(baseName);
    } catch {
      /* catalog optional for sync targeting */
    }
  }
  const projectIds: number[] = [];
  for (const name of names) {
    const src = toolCtx.repo.listSources().find((s) => s.name === name);
    if (src) projectIds.push(src.id);
  }
  const sourceName =
    typeof setBase?.params?.source_name === "string"
      ? setBase.params.source_name
      : names.size === 1
        ? [...names][0]!
        : null;
  proposedActions.push(
    buildSyncAction({
      planId,
      projectIds,
      sourceName,
    }),
  );
}

function dedupeProposedActions(actions: AssistantProposedAction[]): AssistantProposedAction[] {
  const seen = new Set<string>();
  const out: AssistantProposedAction[] = [];
  for (const a of actions) {
    const src =
      typeof a.params?.source_name === "string" ? a.params.source_name.trim().toLowerCase() : "";
    const preset =
      typeof a.params?.preset_id === "string" ? a.params.preset_id.trim().toLowerCase() : "";
    const workflow =
      typeof a.params?.workflow === "string" ? a.params.workflow.trim().toLowerCase() : "";
    const key = `${a.type}|${src}|${preset}|${workflow}|${a.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function catalogBaseSourceNameSet(): Set<string> {
  try {
    const catalog = loadKitCatalog() as Record<string, unknown>;
    const bases = (catalog.bases ?? {}) as Record<string, { source_name?: string }>;
    const names = new Set<string>();
    for (const b of Object.values(bases)) {
      if (typeof b?.source_name === "string" && b.source_name.trim()) {
        names.add(b.source_name.trim());
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

function resolvePresetBaseSourceName(presetId: string): string | null {
  try {
    const catalog = loadKitCatalog() as Record<string, unknown>;
    const presets = catalog.stack_presets as Record<string, { base?: string }> | undefined;
    const bases = catalog.bases as Record<string, { source_name?: string }> | undefined;
    const baseKey = presets?.[presetId]?.base;
    const name = baseKey ? bases?.[baseKey]?.source_name : undefined;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export function userAskedToSwitchBase(userText: string): boolean {
  return /switch\s+base|change\s+base|different\s+base|set\s+base\s+to|use\s+.+\s+as\s+base/i.test(
    userText,
  );
}

function planBaseSourceName(toolCtx: ToolContext): string | null {
  const planId = toolCtx.activePlanId;
  if (planId == null) return null;
  if (!toolCtx.repo.getOwnedProfileIdentity(planId)) return null;
  const layers = toolCtx.repo.getProfileLayers(planId);
  const base = layers.find((l) => l.layer_type === "base");
  return base?.project_name ?? null;
}

/** Word-boundary-ish phrase match against user text (length-capped; no unbounded regex). */
function phraseMatchesUserText(phrase: string, userText: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (!p || p.length < 2 || p.length > 64) return false;
  const hay = userText.toLowerCase();
  let from = 0;
  while (from <= hay.length - p.length) {
    const idx = hay.indexOf(p, from);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : hay[idx - 1]!;
    const after = idx + p.length >= hay.length ? "" : hay[idx + p.length]!;
    const boundaryBefore = !before || /[^a-z0-9]/.test(before);
    const boundaryAfter = !after || /[^a-z0-9]/.test(after);
    if (boundaryBefore && boundaryAfter) return true;
    from = idx + 1;
  }
  return false;
}

/** Safe token match for short kit option ids (ebb36, 5, …). */
function optionIdMentioned(optionId: string, text: string): boolean {
  const id = optionId.trim().toLowerCase();
  if (!id || id.length > 24) return false;
  const hay = text.toLowerCase();
  // Allow optional trailing "s" (EBB36s).
  const candidates = [id, `${id}s`];
  for (const needle of candidates) {
    let from = 0;
    while (from <= hay.length - needle.length) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const before = idx === 0 ? "" : hay[idx - 1]!;
      const after = idx + needle.length >= hay.length ? "" : hay[idx + needle.length]!;
      const boundaryBefore = !before || /[^a-z0-9]/.test(before);
      const boundaryAfter = !after || /[^a-z0-9]/.test(after);
      if (boundaryBefore && boundaryAfter) return true;
      from = idx + 1;
    }
  }
  return false;
}

/**
 * Soft-propose set_base / add_addon / update_kit_selections from domain-pack aliases
 * when the user clearly names a known phrase.
 */
export function appendAliasDrivenHints(
  toolCtx: ToolContext,
  proposedActions: AssistantProposedAction[],
  userText: string,
): void {
  const planId = toolCtx.activePlanId;
  if (planId == null || !userText.trim()) return;
  const aliases = loadAliasEntries(toolCtx.dataDir);
  if (!aliases.length) return;

  const liveSources = toolCtx.repo.listSources();
  const liveNames = new Set(liveSources.map((s) => s.name));
  const catalogBases = catalogBaseSourceNameSet();
  const layers =
    toolCtx.repo.getOwnedProfileIdentity(planId) != null
      ? toolCtx.repo.getProfileLayers(planId)
      : [];
  const attached = new Set(
    layers.map((l) => l.project_name).filter((n): n is string => Boolean(n)),
  );

  const alreadyNamed = (sourceName: string) =>
    proposedActions.some(
      (a) =>
        (a.type === "set_base" || a.type === "add_addon") &&
        typeof a.params?.source_name === "string" &&
        a.params.source_name.trim().toLowerCase() === sourceName.toLowerCase(),
    );

  for (const alias of aliases) {
    const matched = (alias.phrases ?? []).some((ph) => phraseMatchesUserText(ph, userText));
    if (!matched) continue;

    const r = alias.resolve ?? {};
    const sourceName = typeof r.source_name === "string" ? r.source_name.trim() : "";
    if (sourceName && liveNames.has(sourceName) && !alreadyNamed(sourceName)) {
      const isCatalogBase = catalogBases.has(sourceName);
      const alreadyBase = attached.has(sourceName);
      const notes = typeof r.notes === "string" ? r.notes.trim() : "";
      if (isCatalogBase && !alreadyBase) {
        const params: Record<string, unknown> = { source_name: sourceName };
        if (typeof r.tag === "string" && r.tag.trim()) params.tag = r.tag.trim();
        if (typeof r.branch === "string" && r.branch.trim()) params.branch = r.branch.trim();
        proposedActions.push({
          id: randomUUID(),
          type: "set_base",
          plan_id: planId,
          label: `Set base to ${sourceName}${params.tag ? `@${params.tag}` : params.branch ? `@${params.branch}` : ""}`,
          summary: notes || `Alias match — set plan base to ${sourceName}.`,
          params,
        });
      } else if (!isCatalogBase && !attached.has(sourceName)) {
        proposedActions.push({
          id: randomUUID(),
          type: "add_addon",
          plan_id: planId,
          label: `Add addon ${sourceName}`,
          summary: notes || `Alias match — add ${sourceName} as an addon layer.`,
          params: { source_name: sourceName },
        });
      }

      // Implied addons from the alias (e.g. G2XL → Galileo2 already covered; LDO kits).
      for (const addon of r.addons ?? []) {
        const addonName = addon.trim();
        if (!addonName || !liveNames.has(addonName) || alreadyNamed(addonName)) continue;
        if (attached.has(addonName)) continue;
        proposedActions.push({
          id: randomUUID(),
          type: "add_addon",
          plan_id: planId,
          label: `Add addon ${addonName}`,
          summary: notes || `Alias-implied addon ${addonName}.`,
          params: { source_name: addonName },
        });
      }
    }

    if (r.selection && Object.keys(r.selection).length > 0) {
      const hasKitUpdate = proposedActions.some((a) => a.type === "update_kit_selections");
      if (!hasKitUpdate) {
        const summaryBits = Object.entries(r.selection)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        proposedActions.push({
          id: randomUUID(),
          type: "update_kit_selections",
          plan_id: planId,
          label: "Apply kit choices from alias",
          summary:
            (typeof r.notes === "string" && r.notes.trim()) ||
            `Record suggested kit selections (${summaryBits}).`,
          params: { selections: { ...r.selection } },
        });
      }
    }
  }
}

/** True when user text refers to the attached base by name or alias phrase. */
function userRefersToAttachedBase(
  userText: string,
  baseName: string,
  dataDir?: string | null,
): boolean {
  if (!userText.trim()) return false;
  if (phraseMatchesUserText(baseName, userText)) return true;
  // Match last path segment (e.g. "emu" from "DW-Tas/emu") and name tokens (e.g. "Trident").
  const short = baseName.includes("/") ? baseName.split("/").pop()! : baseName;
  if (short && short.length >= 3 && phraseMatchesUserText(short, userText)) return true;
  for (const token of baseName.split(/[-_/]+/).filter((t) => t.length >= 4)) {
    if (phraseMatchesUserText(token, userText)) return true;
  }
  for (const alias of loadAliasEntries(dataDir)) {
    const src = alias.resolve.source_name?.trim();
    if (!src || src.toLowerCase() !== baseName.toLowerCase()) continue;
    for (const phrase of alias.phrases) {
      if (phraseMatchesUserText(phrase, userText)) return true;
    }
  }
  return false;
}

/**
 * When the plan already has a base the user is working on (or a standalone_mmu),
 * and they haven't asked to switch, drop proposals that retarget a different base /
 * invent storefront sources / stack catalog printer bases onto a standalone plan.
 */
export function stripWrongBaseProposalsForAttachedKit(
  toolCtx: ToolContext,
  proposedActions: AssistantProposedAction[],
  userText: string,
): void {
  const baseName = planBaseSourceName(toolCtx);
  if (!baseName) return;
  if (userAskedToSwitchBase(userText)) return;

  const catalogBases = catalogBaseSourceNameSet();
  const identity = findIdentityForSource(baseName, toolCtx.dataDir);
  const role = identity?.role?.trim() ?? null;
  const baseIsStandalone = role === "standalone_mmu";
  // Only guard when the conversation is about the attached kit, or it is a
  // standalone MMU (never silently reframe as a catalog printer stack).
  if (!baseIsStandalone && !userRefersToAttachedBase(userText, baseName, toolCtx.dataDir)) {
    return;
  }

  for (let i = proposedActions.length - 1; i >= 0; i -= 1) {
    const a = proposedActions[i]!;

    if (a.type === "propose_add_source") {
      const url = typeof a.params?.url === "string" ? a.params.url.trim() : "";
      if (!url || !isStlRepoUrl(url)) {
        proposedActions.splice(i, 1);
      }
      continue;
    }

    if (a.type === "set_base") {
      const src =
        typeof a.params?.source_name === "string" ? a.params.source_name.trim() : "";
      if (src && src.toLowerCase() !== baseName.toLowerCase()) {
        proposedActions.splice(i, 1);
      }
      continue;
    }

    if (a.type === "apply_stack_preset") {
      const preset =
        typeof a.params?.preset_id === "string" ? a.params.preset_id.trim() : "";
      const presetBase = preset ? resolvePresetBaseSourceName(preset) : null;
      const explicitSrc =
        typeof a.params?.source_name === "string" ? a.params.source_name.trim() : "";
      const target = explicitSrc || presetBase;
      if (target && target.toLowerCase() !== baseName.toLowerCase()) {
        proposedActions.splice(i, 1);
      } else if (!target && preset) {
        // Unknown preset while protecting attached kit — drop to avoid wrong-base stacks.
        proposedActions.splice(i, 1);
      }
      continue;
    }

    if (a.type === "add_addon" && baseIsStandalone) {
      const src =
        typeof a.params?.source_name === "string" ? a.params.source_name.trim() : "";
      // Don't soft-attach catalog printer bases as addons onto a standalone plan.
      if (src && catalogBases.has(src)) {
        proposedActions.splice(i, 1);
      }
    }
  }
}

/** HTTP(S) URLs in user text (best-effort). */
export function extractUserHttpUrls(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    out.push(m[0]!.replace(/[.,;:!?]+$/g, ""));
  }
  return [...new Set(out)];
}

export function isStlRepoUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.includes("github.com") ||
      host.includes("printables.com") ||
      host.includes("makerworld.com")
    );
  } catch {
    return false;
  }
}

/** Build constraint text from a kit-page GuideExtract (notes + open questions). */
export function kitConstraintsFromGuideExtract(extract: {
  notes?: string[];
  open_questions?: string[];
  links?: Array<{ url: string; kind: string }>;
}): string {
  const bits: string[] = [];
  for (const n of extract.notes ?? []) bits.push(n);
  for (const q of extract.open_questions ?? []) bits.push(q);
  const gh = (extract.links ?? []).find((l) => /github\.com/i.test(l.url));
  if (gh) bits.push(`STL source: ${gh.url}`);
  return bits.join(" ").slice(0, 800);
}

/**
 * After detect_build_decisions, ensure Apply cards exist: focus the first group and
 * propose update_kit_selections for user-matched electronics/lane (etc.) suggestions.
 */
export function appendBuildDecisionHints(
  toolCtx: ToolContext,
  proposedActions: AssistantProposedAction[],
  userText: string,
  decisions: BuildDecision[] | null,
): void {
  const planId = toolCtx.activePlanId;
  if (planId == null || !decisions?.length) return;

  const hasKitUpdate = proposedActions.some((a) => a.type === "update_kit_selections");
  const hasFocus = proposedActions.some((a) => a.type === "ui_focus_kit_option");

  // Only soft-Apply choices the user actually stated — not LLM defaults
  // for unrelated PCB/combiner variants.
  const suggested: Record<string, string> = {};
  for (const d of decisions) {
    if (!d.suggested_selection) continue;
    const opt = d.options.find((o) => o.id === d.suggested_selection);
    if (!opt?.selection || Object.keys(opt.selection).length === 0) continue;
    if (d.id === "electronics_board") {
      if (optionIdMentioned(opt.id, userText)) {
        Object.assign(suggested, opt.selection);
      }
      continue;
    }
    if (d.id === "lane_count") {
      const id = opt.id.trim().toLowerCase();
      if (id && id.length <= 8) {
        const hay = userText.toLowerCase();
        // Match "5 lane" / "5 lanes" without building unbounded regexes from user text.
        const needles = [`${id} lane`, `${id} lanes`];
        if (needles.some((n) => hay.includes(n))) {
          Object.assign(suggested, opt.selection);
        }
      }
      continue;
    }
  }
  if (!hasKitUpdate && Object.keys(suggested).length > 0) {
    const summaryBits = Object.entries(suggested)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    proposedActions.push({
      id: randomUUID(),
      type: "update_kit_selections",
      plan_id: planId,
      label: "Apply kit choices from your constraints",
      summary: `Record suggested kit selections (${summaryBits}). Confirm to Apply — you can change PCB/mods next.`,
      params: { selections: suggested },
    });
  }

  if (!hasFocus) {
    const focus =
      decisions.find((d) => d.id === "electronics_board" && d.suggested_selection) ??
      decisions.find((d) => d.id === "pcb_recommended_options") ??
      decisions.find((d) =>
        d.options.some((o) => o.selection && Object.keys(o.selection).length > 0),
      ) ??
      decisions[0];
    if (focus) {
      let stlFilter: string | undefined;
      for (const opt of focus.options) {
        if (optionIdMentioned(opt.id, userText)) {
          stlFilter = opt.label.replace(/\s+/g, "") || opt.id.toUpperCase();
          break;
        }
      }
      proposedActions.push({
        id: randomUUID(),
        type: "ui_focus_kit_option",
        plan_id: planId,
        label: `Focus Build: ${focus.label}`,
        summary: `Open Build and focus decision “${focus.label}” so you can confirm the STL pick.`,
        params: {
          group_id: focus.id,
          ...(stlFilter ? { stl_filter: stlFilter } : {}),
          plan_id: planId,
        },
      });
    }
  }
}

/**
 * Soft path for kit storefront URLs: ingest as BOM evidence, and if decisions
 * were never captured, re-run detect on the attached plan base.
 */
export async function ensureKitProductEvidence(params: {
  toolCtx: ToolContext;
  userText: string;
  lastDecisions: BuildDecision[] | null;
  didIngestGuide: boolean;
}): Promise<{ lastDecisions: BuildDecision[] | null; kitConstraintExtra: string }> {
  const { toolCtx, userText } = params;
  let lastDecisions = params.lastDecisions;
  let kitConstraintExtra = "";
  let didIngestGuide = params.didIngestGuide;

  const productUrls = extractUserHttpUrls(userText).filter((u) => !isStlRepoUrl(u));
  if (productUrls.length && !didIngestGuide) {
    for (const url of productUrls.slice(0, 2)) {
      const invoked = await invokeAssistantTool("ingest_guide_url", { url }, toolCtx);
      try {
        const parsed = JSON.parse(invoked.content) as {
          ok?: boolean;
          extract?: {
            notes?: string[];
            open_questions?: string[];
            links?: Array<{ url: string; kind: string }>;
          };
          untrusted_text?: string;
        };
        if (parsed.ok && parsed.extract) {
          didIngestGuide = true;
          kitConstraintExtra = kitConstraintsFromGuideExtract(parsed.extract);
          // Pull lane/board phrases from page text into constraints for soft Apply.
          const page = (parsed.untrusted_text ?? "").slice(0, 1200);
          if (/\b5\s*[- ]?lane/i.test(page) && !/\b5\s*lanes?\b/i.test(userText)) {
            kitConstraintExtra += " 5 lanes";
          }
          const boardInUser = userText.match(/\b((?:EBB|SHT|MMB|SLB|BTT)[-_]?\w+)\b/i);
          if (boardInUser) {
            kitConstraintExtra += ` ${boardInUser[1]}`;
          } else {
            const boardInPage = page.match(/\b((?:EBB|SHT|MMB|SLB|BTT)[-_]?\w+)\b/i);
            if (boardInPage) {
              kitConstraintExtra += ` ${boardInPage[1]} (kit page mention)`;
            }
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  const baseName = planBaseSourceName(toolCtx);
  const wantsKitWalkthrough =
    Boolean(kitConstraintExtra) ||
    productUrls.length > 0 ||
    /\b\d+\s*[- ]?lanes?\b/i.test(userText) ||
    /\b(?:EBB|SHT|MMB|SLB|BTT)[-_]?\w+\b/i.test(userText);
  if (baseName && wantsKitWalkthrough) {
    const constraints = `${userText} ${kitConstraintExtra}`.trim().slice(0, 800);
    if (!lastDecisions?.length) {
      const invoked = await invokeAssistantTool(
        "detect_build_decisions",
        {
          source_name: baseName,
          plan_id: toolCtx.activePlanId,
          user_constraints: constraints,
        },
        toolCtx,
      );
      try {
        const parsed = JSON.parse(invoked.content) as { decisions?: BuildDecision[] };
        if (Array.isArray(parsed.decisions) && parsed.decisions.length) {
          lastDecisions = parsed.decisions;
        }
      } catch {
        /* ignore */
      }
    } else if (kitConstraintExtra) {
      lastDecisions = applyUserConstraintsToDecisions(lastDecisions, constraints);
    }
  }

  return { lastDecisions, kitConstraintExtra };
}

function finalizeProposedActions(
  toolCtx: ToolContext,
  proposedActions: AssistantProposedAction[],
  userText = "",
  lastDecisions: BuildDecision[] | null = null,
): void {
  // Dedupe identical set_base / add_addon cards from multi-round tool spam.
  const deduped = dedupeProposedActions(proposedActions);
  proposedActions.length = 0;
  proposedActions.push(...deduped);
  stripWrongBaseProposalsForAttachedKit(toolCtx, proposedActions, userText);
  appendAliasDrivenHints(toolCtx, proposedActions, userText);
  appendBuildDecisionHints(toolCtx, proposedActions, userText, lastDecisions);
  appendSoftStackSuggestions(toolCtx, proposedActions);
  appendSyncIfNeeded(toolCtx, proposedActions);
  // Hard-filter dismissed fingerprints so recovered/soft cards never reach Apply UI.
  const kept = proposedActions.filter((a) => {
    if (!a.plan_id || a.plan_id <= 0) return true;
    return !isDismissedFingerprint(toolCtx.repo, a.plan_id, a.type, a.params ?? {});
  });
  if (kept.length !== proposedActions.length) {
    proposedActions.length = 0;
    proposedActions.push(...kept);
  }
}

const MAX_TOOL_ROUNDS = 4;

export type RunAssistantTurnOptions = {
  assistant: AssistantPort;
  system: string;
  messages: AssistantChatMessage[];
  model: string;
  maxTokens: number;
  toolCtx: ToolContext;
};

/**
 * Multi-round tool loop when the provider supports tools; otherwise returns
 * toolsDegraded so the caller can stream a plain completion with stuffed context.
 */
export async function runAssistantTurn(
  options: RunAssistantTurnOptions,
): Promise<AssistantTurnResult> {
  const { assistant, system, messages, model, maxTokens, toolCtx } = options;

  if (!assistant.supportsTools || !assistant.completeWithTools) {
    return { content: "", proposedActions: [], toolsDegraded: true };
  }

  const toolMessages: AssistantToolMessage[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const proposedActions: AssistantProposedAction[] = [];
  let lastContent = "";
  let lastDecisions: BuildDecision[] | null = null;
  let didIngestGuide = false;
  const userText = [...messages]
    .reverse()
    .find((m) => m.role === "user")
    ?.content ?? "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await assistant.completeWithTools({
      system,
      messages: toolMessages,
      model,
      maxTokens,
      tools: ASSISTANT_TOOL_SPECS,
    });
    lastContent = result.content || lastContent;

    let toolCalls: AssistantToolCallRequest[] = result.toolCalls;
    let recoveredFromText = false;
    if (toolCalls.length === 0 && result.content) {
      const recovered = parseTextEmbeddedToolCalls(result.content);
      if (recovered.length > 0) {
        toolCalls = recovered;
        recoveredFromText = true;
      }
    }

    if (toolCalls.length === 0) {
      let content = stripEmbeddedToolCallJson(result.content || lastContent);
      if (proposedActions.length === 0 && content) {
        const recovered = await recoverProposedActionsFromText(content, toolCtx);
        if (recovered.actions.length) {
          proposedActions.push(...recovered.actions);
          content = recovered.cleanedContent;
        } else if (recovered.cleanedContent !== content) {
          content = recovered.cleanedContent;
        }
      }
      const ensured = await ensureKitProductEvidence({
        toolCtx,
        userText,
        lastDecisions,
        didIngestGuide,
      });
      lastDecisions = ensured.lastDecisions;
      finalizeProposedActions(toolCtx, proposedActions, userText, lastDecisions);
      return {
        content,
        proposedActions,
        toolsDegraded: false,
      };
    }

    toolMessages.push({
      role: "assistant",
      content: recoveredFromText ? "" : result.content || "",
      toolCalls,
    });

    for (const call of toolCalls) {
      // Auto-fill user_constraints on detect when the model omitted them.
      const input = { ...(call.input ?? {}) };
      if (
        call.name === "detect_build_decisions" &&
        typeof input.user_constraints !== "string" &&
        userText.trim()
      ) {
        input.user_constraints = userText.slice(0, 500);
      }
      // If the model invents a source_name that isn't synced, prefer the plan base.
      if (
        call.name === "detect_build_decisions" &&
        typeof input.source_name === "string" &&
        input.source_name.trim()
      ) {
        const sn = input.source_name.trim();
        const exists = toolCtx.repo.listSources().some((s) => s.name === sn);
        if (!exists) {
          const base = planBaseSourceName(toolCtx);
          if (base) input.source_name = base;
        }
      }
      const invoked = await invokeAssistantTool(call.name, input, toolCtx);
      if (invoked.proposedAction) {
        proposedActions.push(invoked.proposedAction);
      }
      if (call.name === "ingest_guide_url") didIngestGuide = true;
      if (call.name === "detect_build_decisions") {
        try {
          const parsed = JSON.parse(invoked.content) as { decisions?: BuildDecision[] };
          if (Array.isArray(parsed.decisions)) lastDecisions = parsed.decisions;
        } catch {
          /* ignore */
        }
      }
      toolMessages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: invoked.content,
      });
    }
  }

  let finalContent = stripEmbeddedToolCallJson(
    lastContent ||
      "I reached the tool-call limit. Please refine your question or try again.",
  );
  if (proposedActions.length === 0 && finalContent) {
    const recovered = await recoverProposedActionsFromText(finalContent, toolCtx);
    if (recovered.actions.length) {
      proposedActions.push(...recovered.actions);
      finalContent = recovered.cleanedContent;
    }
  }

  const ensured = await ensureKitProductEvidence({
    toolCtx,
    userText,
    lastDecisions,
    didIngestGuide,
  });
  lastDecisions = ensured.lastDecisions;
  finalizeProposedActions(toolCtx, proposedActions, userText, lastDecisions);

  return {
    content: finalContent,
    proposedActions,
    toolsDegraded: false,
  };
}

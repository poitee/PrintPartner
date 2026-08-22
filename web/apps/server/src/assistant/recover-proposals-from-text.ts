import type { AssistantProposedAction } from "@print-partner/contracts";
import { invokeAssistantTool, type ToolContext } from "./tools.js";
import { stripEmbeddedToolCallJson } from "./parse-text-tool-calls.js";
import { sanitizeAssistantDisplayText } from "./sanitize-display-text.js";
import { buildSyncAction } from "./sync-action.js";

type RecipeLike = {
  base?: {
    source_name?: string;
    tag?: string | null;
    branch?: string | null;
  };
  addons?: Array<{ source_name?: string; name?: string; tag?: string; branch?: string }>;
};

function extractRecipeJson(content: string): RecipeLike | null {
  const candidates: string[] = [];
  const fence = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fence?.[1]) candidates.push(fence[1]);
  for (const m of content.matchAll(/(\{\s*"plan_id"[\s\S]*?\n\})/g)) {
    if (m[1]) candidates.push(m[1]);
  }
  if (candidates.length === 0) {
    const loose = content.match(
      /(\{[\s\S]*?"base"\s*:\s*\{[\s\S]*?"source_name"[\s\S]*?\})/,
    );
    if (loose?.[1]) candidates.push(loose[1]);
  }
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as RecipeLike;
      if (parsed?.base?.source_name || (parsed.addons && parsed.addons.length)) {
        return parsed;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function looksLikeFakeApplyPitch(content: string): boolean {
  return (
    /click\s+(?:on\s+)?(?:the\s+)?["']?Apply["']?\s+button/i.test(content) ||
    /confirm to proceed/i.test(content) ||
    /here is an example of what the build recipe/i.test(content) ||
    /"base"\s*:\s*\{[\s\S]*"source_name"/i.test(content)
  );
}

/** Model invents shell/commands or narrates stacking without calling tools. */
function looksLikeProseStackNarration(content: string): boolean {
  return (
    /use the following command/i.test(content) ||
    /run the following/i.test(content) ||
    /you can (?:use|run|execute) the following/i.test(content) ||
    /to add (?:the )?(?:ldo|leviathan|addon|stealthburner|a4t)/i.test(content) ||
    /add(?:ing)? (?:the )?(?:following )?addons?/i.test(content) ||
    /attach(?:ing)? .{0,40} as (?:an )?addon/i.test(content) ||
    /set(?:ting)? (?:the )?base to/i.test(content) ||
    /voron[- ]?trident.{0,40}(?:r2|vtr2)/i.test(content)
  );
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Find live sources mentioned in prose (exact name, compact match, or common phrases).
 */
export function extractMentionedSourceNames(
  content: string,
  liveNames: string[],
): { base?: { source_name: string; tag?: string }; addons: string[] } {
  const byCompact = new Map(liveNames.map((n) => [compact(n), n]));
  const addons: string[] = [];
  const pushAddon = (name: string | undefined) => {
    if (!name) return;
    if (!addons.includes(name)) addons.push(name);
  };

  for (const name of liveNames) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}\\b`, "i").test(content)) {
      // Prefer classifying as addon unless clearly base context for Trident/Voron-2/etc.
      pushAddon(name);
    } else if (content.toLowerCase().includes(compact(name)) && compact(name).length >= 8) {
      pushAddon(name);
    }
  }

  // Phrase → known kit pieces (only if live)
  const phraseMap: Array<{ re: RegExp; names: string[] }> = [
    {
      // Full LDO Trident R2 stack (matches domain stacks.yaml)
      re: /ldo\s*(?:voron\s*)?trident\s*r2|trident\s*r2.{0,40}ldo|ldo\s*addons?/i,
      names: ["LDOVoronTrident", "Voron-Stealthburner"],
    },
    { re: /\bleviathan\b/i, names: ["Leviathan"] },
    { re: /\bstealthburner\b/i, names: ["Voron-Stealthburner"] },
    { re: /\ba4t\b/i, names: ["A4T", "a4t_toolhead", "A4T-Toolhead"] },
    { re: /\btap\b|voron[- ]?tap/i, names: ["Voron-Tap"] },
    { re: /\bklicky\b/i, names: ["Klicky-Probe"] },
  ];
  for (const p of phraseMap) {
    if (!p.re.test(content)) continue;
    for (const n of p.names) {
      const live = byCompact.get(compact(n)) ?? liveNames.find((x) => compact(x) === compact(n));
      pushAddon(live);
    }
  }

  let base: { source_name: string; tag?: string } | undefined;
  if (/voron[- ]?trident/i.test(content)) {
    const trident = byCompact.get("vorontrident") ?? liveNames.find((n) => /trident/i.test(n) && !/ldo/i.test(n));
    if (trident) {
      const tag = /(?:\br2\b|vtr2)/i.test(content) ? "VTr2" : undefined;
      base = { source_name: trident, ...(tag ? { tag } : {}) };
      // Trident as base shouldn't stay only in addons list
      const idx = addons.indexOf(trident);
      if (idx >= 0) addons.splice(idx, 1);
    }
  }

  return { base, addons };
}

function cleanNarrationScaffolding(content: string): string {
  let cleaned = stripEmbeddedToolCallJson(content);
  cleaned = sanitizeAssistantDisplayText(cleaned);
  cleaned = cleaned.replace(/```(?:json|bash|sh|shell)?\s*[\s\S]*?```/gi, "");
  cleaned = cleaned.replace(/\bHere is an example of what the build recipe[\s\S]*?(?=\n\n|$)/gi, "");
  cleaned = cleaned.replace(/\bPlease note that this is just an example[\s\S]*?(?=\n\n|$)/gi, "");
  cleaned = cleaned.replace(
    /\bTo apply these settings, click[\s\S]*?(?:proceed|build|UI)\.?\s*/gi,
    "",
  );
  cleaned = cleaned.replace(/\bPlease confirm to proceed[\s\S]*$/gi, "");
  cleaned = cleaned.replace(
    /\b(?:you can )?(?:use|run|execute) the following command[\s\S]*?(?=\n\n|$)/gi,
    "",
  );
  cleaned = cleaned.replace(/\bTo add the .{0,80}, you can use[\s\S]*?(?=\n\n|$)/gi, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

/**
 * When a local model dumps a fake recipe JSON / "click Apply" pitch / prose stack
 * narration without calling mutating tools, turn that into real proposed action cards.
 */
export async function recoverProposedActionsFromText(
  content: string,
  toolCtx: ToolContext,
): Promise<{ actions: AssistantProposedAction[]; cleanedContent: string }> {
  if (!content.trim()) return { actions: [], cleanedContent: content };

  const recipe = extractRecipeJson(content);
  const prose =
    !recipe &&
    (looksLikeProseStackNarration(content) || looksLikeFakeApplyPitch(content))
      ? extractMentionedSourceNames(
          content,
          toolCtx.repo.listSources().map((s) => s.name),
        )
      : null;

  if (!looksLikeFakeApplyPitch(content) && !recipe && !prose?.base && !(prose?.addons.length)) {
    return { actions: [], cleanedContent: content };
  }

  const actions: AssistantProposedAction[] = [];
  const planId = toolCtx.activePlanId;
  const seen = new Set<string>();

  const proposeBase = async (sourceName: string, tag?: string | null, branch?: string | null) => {
    const key = `base:${sourceName}:${tag ?? ""}:${branch ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const input: Record<string, unknown> = {
      source_name: sourceName,
      ...(planId != null ? { plan_id: planId } : {}),
    };
    if (tag) input.tag = tag;
    if (branch) input.branch = branch;
    const { proposedAction } = await invokeAssistantTool("set_base", input, toolCtx);
    if (proposedAction) actions.push(proposedAction);
  };

  const proposeAddon = async (sourceName: string) => {
    const key = `addon:${sourceName}`;
    if (seen.has(key)) return;
    seen.add(key);
    const input: Record<string, unknown> = {
      source_name: sourceName,
      ...(planId != null ? { plan_id: planId } : {}),
    };
    const { proposedAction } = await invokeAssistantTool("add_addon", input, toolCtx);
    if (proposedAction) actions.push(proposedAction);
  };

  if (recipe?.base?.source_name) {
    await proposeBase(recipe.base.source_name, recipe.base.tag, recipe.base.branch);
  } else if (prose?.base) {
    await proposeBase(prose.base.source_name, prose.base.tag);
  }

  for (const addon of recipe?.addons ?? []) {
    const name = addon.source_name || addon.name;
    if (name) await proposeAddon(name);
  }
  for (const name of prose?.addons ?? []) {
    await proposeAddon(name);
  }

  // After a tagged set_base (and any addons), offer Sync as the next card.
  const setBase = actions.find((a) => a.type === "set_base");
  const tag =
    setBase && typeof setBase.params?.tag === "string" ? setBase.params.tag.trim() : "";
  if (planId != null && setBase && tag) {
    const names = new Set<string>();
    for (const a of actions) {
      if (a.type !== "set_base" && a.type !== "add_addon") continue;
      const n = a.params?.source_name;
      if (typeof n === "string" && n.trim()) names.add(n.trim());
    }
    const projectIds: number[] = [];
    for (const name of names) {
      const src = toolCtx.repo.listSources().find((s) => s.name === name);
      if (src) projectIds.push(src.id);
    }
    actions.push(
      buildSyncAction({
        planId,
        projectIds,
        sourceName:
          typeof setBase.params?.source_name === "string"
            ? setBase.params.source_name
            : null,
      }),
    );
  }

  let cleaned = cleanNarrationScaffolding(content);

  if (actions.length) {
    cleaned =
      (cleaned ? `${cleaned}\n\n` : "") +
      `Proposed ${actions.length} change(s) below — use the Apply cards to confirm. Nothing has been changed yet.`;
  } else if (looksLikeFakeApplyPitch(content) || looksLikeProseStackNarration(content)) {
    cleaned =
      (cleaned ? `${cleaned}\n\n` : "") +
      "I couldn’t turn that into Apply cards (missing or unknown sources). Ask me to list synced sources and use exact names (e.g. Voron-Trident @ VTr2, LDOVoronTrident, Leviathan). A4T only works if that source is registered.";
  }

  return { actions, cleanedContent: cleaned };
}

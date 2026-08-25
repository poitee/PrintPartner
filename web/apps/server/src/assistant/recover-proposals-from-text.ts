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
    /to add (?:the )?(?:following )?(?:addons?|layers?|sources?)/i.test(content) ||
    /add(?:ing)? (?:the )?(?:following )?addons?/i.test(content) ||
    /attach(?:ing)? .{0,40} as (?:an )?addon/i.test(content) ||
    /set(?:ting)? (?:the )?base to/i.test(content)
  );
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Same-sentence gap that tolerates a period inside a version number. */
const GAP = "(?:[^.!?\\n]|\\.(?=\\d))";

/** Separator-insensitive: `Example-Repo` also matches "Example Repo"/"Example_Repo". */
function namePattern(sourceName: string): string {
  return sourceName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[-_ ]?");
}

/**
 * A git ref the prose attaches to this source: "Example-Repo @ v2.1",
 * "Example-Repo at tag REL3". Shape-based, so any project's naming works.
 */
function tagNear(content: string, sourceName: string): string | undefined {
  const m = new RegExp(
    `\\b${namePattern(sourceName)}\\b\\s*(?:@|\\bat\\b|\\bon\\b)?\\s*(?:tag|branch|ref|release)?\\s*[\`"']?([A-Za-z0-9][\\w.\\-/]{1,38})[\`"']?`,
    "i",
  ).exec(content);
  const value = m?.[1]?.replace(/[.,;:)]+$/, "");
  // Only accept something that looks like a ref, not the next prose word.
  if (!value || !/\d/.test(value)) return undefined;
  return value;
}

/**
 * Find live sources mentioned in prose (exact name or compact match).
 *
 * Only names this workspace has synced can come out of here — there is no
 * built-in list of products, so nothing gets proposed that the user does not
 * already have.
 */
export function extractMentionedSourceNames(
  content: string,
  liveNames: string[],
): { base?: { source_name: string; tag?: string }; addons: string[] } {
  const addons: string[] = [];
  const pushAddon = (name: string | undefined) => {
    if (!name) return;
    if (!addons.includes(name)) addons.push(name);
  };

  for (const name of liveNames) {
    if (new RegExp(`\\b${namePattern(name)}\\b`, "i").test(content)) {
      // Default to addon; the base pass below promotes one if the prose says so.
      pushAddon(name);
    } else if (content.toLowerCase().includes(compact(name)) && compact(name).length >= 8) {
      pushAddon(name);
    }
  }

  // Whichever mentioned source the prose frames as the base becomes the base;
  // the rest stay addons. Read from the text, never from a built-in name list.
  // When several names sit near a "base" cue, the nearest one wins, so
  // "set the base to A, then attach B" picks A rather than list order.
  let base: { source_name: string; tag?: string } | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const name of addons) {
    const esc = namePattern(name);
    const lead = new RegExp(
      `(?:base|structural base|start(?:ing)? (?:from|with)|built on|on top of)\\b(${GAP}{0,60}?)\\b${esc}\\b`,
      "i",
    ).exec(content);
    const trail = new RegExp(
      `\\b${esc}\\b(${GAP}{0,40}?)\\bas (?:the )?base\\b`,
      "i",
    ).exec(content);
    const gap = Math.min(lead?.[1]?.length ?? Infinity, trail?.[1]?.length ?? Infinity);
    if (gap >= bestGap) continue;
    bestGap = gap;
    const tag = tagNear(content, name);
    base = { source_name: name, ...(tag ? { tag } : {}) };
  }
  if (base) addons.splice(addons.indexOf(base.source_name), 1);

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
      "I couldn’t turn that into Apply cards (missing or unknown sources). Ask me to list synced sources and use their exact names — a source has to be registered here before I can put it on a plan.";
  }

  return { actions, cleanedContent: cleaned };
}

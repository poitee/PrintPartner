import type { AppRepository } from "../db/repository.js";
import { deriveBuildRecipe } from "./build-recipe.js";
import { loadKitManifest } from "./kit-manifest-store.js";

export type PlanCompareDiff = {
  plan_a: { id: number; name: string };
  plan_b: { id: number; name: string };
  base: { a: string | null; b: string | null; same: boolean };
  addons: { only_a: string[]; only_b: string[]; shared: string[] };
  refs: Array<{ source: string; a: string | null; b: string | null; same: boolean }>;
  kit_selections: {
    only_a: Record<string, string>;
    only_b: Record<string, string>;
    changed: Array<{ key: string; a: string; b: string }>;
  };
  recent_decisions: {
    a: Array<{ label: string; kind: string; summary: string }>;
    b: Array<{ label: string; kind: string; summary: string }>;
  };
  bullets: string[];
};

function refLabel(tag: string | null, branch: string | null): string | null {
  if (tag) return `tag:${tag}`;
  if (branch) return `branch:${branch}`;
  return null;
}

export function comparePlans(
  repo: AppRepository,
  planAId: number,
  planBId: number,
): PlanCompareDiff | { error: string } {
  const recipeA = deriveBuildRecipe(repo, planAId);
  const recipeB = deriveBuildRecipe(repo, planBId);
  if (!recipeA) return { error: `Plan not found: ${planAId}` };
  if (!recipeB) return { error: `Plan not found: ${planBId}` };

  const baseA = recipeA.base.source_name
    ? `${recipeA.base.source_name}${recipeA.base.tag ? `@${recipeA.base.tag}` : ""}`
    : null;
  const baseB = recipeB.base.source_name
    ? `${recipeB.base.source_name}${recipeB.base.tag ? `@${recipeB.base.tag}` : ""}`
    : null;

  const setA = new Set(recipeA.addons.map((a) => a.source_name));
  const setB = new Set(recipeB.addons.map((a) => a.source_name));
  const only_a = [...setA].filter((n) => !setB.has(n)).sort();
  const only_b = [...setB].filter((n) => !setA.has(n)).sort();
  const shared = [...setA].filter((n) => setB.has(n)).sort();

  const refs: PlanCompareDiff["refs"] = [];
  const allNames = new Set<string>();
  if (recipeA.base.source_name) allNames.add(recipeA.base.source_name);
  if (recipeB.base.source_name) allNames.add(recipeB.base.source_name);
  for (const a of recipeA.addons) allNames.add(a.source_name);
  for (const a of recipeB.addons) allNames.add(a.source_name);
  for (const name of [...allNames].sort()) {
    const aLayer =
      recipeA.base.source_name === name
        ? recipeA.base
        : recipeA.addons.find((x) => x.source_name === name);
    const bLayer =
      recipeB.base.source_name === name
        ? recipeB.base
        : recipeB.addons.find((x) => x.source_name === name);
    const aRef = aLayer ? refLabel(aLayer.tag, aLayer.branch) : null;
    const bRef = bLayer ? refLabel(bLayer.tag, bLayer.branch) : null;
    if (aLayer || bLayer) {
      refs.push({ source: name, a: aRef, b: bRef, same: aRef === bRef });
    }
  }

  const selA = loadKitManifest(repo, planAId).selections;
  const selB = loadKitManifest(repo, planBId).selections;
  const onlyASel: Record<string, string> = {};
  const onlyBSel: Record<string, string> = {};
  const changed: Array<{ key: string; a: string; b: string }> = [];
  for (const [k, v] of Object.entries(selA)) {
    if (!(k in selB)) onlyASel[k] = v;
    else if (selB[k] !== v) changed.push({ key: k, a: v, b: selB[k]! });
  }
  for (const [k, v] of Object.entries(selB)) {
    if (!(k in selA)) onlyBSel[k] = v;
  }

  const decisionsA = repo.listPlanDecisions(planAId).slice(-8);
  const decisionsB = repo.listPlanDecisions(planBId).slice(-8);

  const bullets: string[] = [];
  if (baseA !== baseB) {
    bullets.push(`Base differs: ${baseA ?? "(none)"} vs ${baseB ?? "(none)"}`);
  } else {
    bullets.push(`Same base: ${baseA ?? "(none)"}`);
  }
  if (only_a.length) bullets.push(`Addons only on #${planAId}: ${only_a.join(", ")}`);
  if (only_b.length) bullets.push(`Addons only on #${planBId}: ${only_b.join(", ")}`);
  if (!only_a.length && !only_b.length) bullets.push("Same addon set");
  for (const r of refs.filter((x) => !x.same)) {
    bullets.push(`Ref ${r.source}: ${r.a ?? "—"} vs ${r.b ?? "—"}`);
  }
  for (const c of changed.slice(0, 6)) {
    bullets.push(`Selection ${c.key}: ${c.a} → ${c.b}`);
  }
  for (const d of decisionsA.slice(-3)) {
    if (d.kind === "applied_action" || d.kind === "choice") {
      bullets.push(`#${planAId} decided: ${d.label}${d.summary ? ` — ${d.summary.slice(0, 80)}` : ""}`);
    }
  }
  for (const d of decisionsB.slice(-3)) {
    if (d.kind === "applied_action" || d.kind === "choice") {
      bullets.push(`#${planBId} decided: ${d.label}${d.summary ? ` — ${d.summary.slice(0, 80)}` : ""}`);
    }
  }

  return {
    plan_a: { id: planAId, name: recipeA.plan_name },
    plan_b: { id: planBId, name: recipeB.plan_name },
    base: { a: baseA, b: baseB, same: baseA === baseB },
    addons: { only_a, only_b, shared },
    refs,
    kit_selections: { only_a: onlyASel, only_b: onlyBSel, changed },
    recent_decisions: {
      a: decisionsA.map((d) => ({
        label: d.label,
        kind: d.kind,
        summary: d.summary,
      })),
      b: decisionsB.map((d) => ({
        label: d.label,
        kind: d.kind,
        summary: d.summary,
      })),
    },
    bullets,
  };
}

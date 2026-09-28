/**
 * Executable kit interaction graph: conflicts, slots, part replacements.
 * Combines domain-pack compatibility + kit-catalog pick_one + global merge_conflicts.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeCompatibility,
  type NormalizedCompatibility,
  type PartReplacement,
} from "../assistant/compatibility.js";
import { domainPackRoots, loadYamlFile } from "../assistant/domain-pack.js";
import { loadKitCatalog } from "./kit-catalog.js";

function normalizeMergeConflict(raw: unknown): {
  slug_or_path: string;
  sources: string[];
  resolution: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const paths = Array.isArray(o.paths) ? o.paths.map(String) : [];
  const slug =
    (o.slug_or_path != null && String(o.slug_or_path)) ||
    (o.id != null && String(o.id)) ||
    paths[0] ||
    "?";
  const sources = Array.isArray(o.sources)
    ? o.sources.map(String)
    : Array.isArray(o.stacks)
      ? o.stacks.map(String)
      : [];
  return {
    slug_or_path: slug,
    sources,
    resolution: o.resolution != null ? String(o.resolution) : "",
  };
}

type InteractionWarning = {
  severity: "warning" | "info";
  code: string;
  message: string;
  sources?: string[];
  conflict_id?: string;
  slot?: string;
};

type StackCompatibilityResult = {
  layers: string[];
  warnings: InteractionWarning[];
  suggested_excludes: string[];
  conflicts: Array<{ a: string; b: string; reason: string }>;
  slots_occupied: Record<string, string[]>;
};

type SourceExplanation = {
  source_name: string;
  kind: string | null;
  attaches_to_bases: string[];
  conflicts_with: string[];
  not_for: string[];
  replaces_slots: string[];
  replaces_parts: PartReplacement[];
  replaces: string[];
  catalog_category: string | null;
  catalog_slot: string | null;
  merge_conflict_ids: string[];
};

type InteractionGraph = {
  bySource: Map<string, NormalizedCompatibility>;
  catalogSlots: Map<string, { category: string; peers: string[] }>;
  mergeConflicts: Array<{
    id: string;
    sources: string[];
    resolution: string;
    paths: string[];
  }>;
};

function loadAllCompatibility(dataDir?: string | null): Map<string, NormalizedCompatibility> {
  const bySource = new Map<string, NormalizedCompatibility>();
  const seen = new Set<string>();
  for (const root of domainPackRoots(dataDir)) {
    const sourcesRoot = join(root, "sources");
    if (!existsSync(sourcesRoot)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(sourcesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of dirs) {
      if (seen.has(name)) continue;
      seen.add(name);
      const raw = loadYamlFile(join(sourcesRoot, name, "compatibility.yaml"));
      const norm = normalizeCompatibility(raw);
      if (norm) bySource.set(norm.source_name, norm);
    }
  }
  return bySource;
}

function loadMergeConflicts(dataDir?: string | null): InteractionGraph["mergeConflicts"] {
  for (const root of domainPackRoots(dataDir)) {
    const path = join(root, "_global", "merge_conflicts.yaml");
    if (!existsSync(path)) continue;
    const raw = loadYamlFile(path) as { conflicts?: unknown[] } | null;
    const out: InteractionGraph["mergeConflicts"] = [];
    for (const item of raw?.conflicts ?? []) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const norm = normalizeMergeConflict(item);
      if (!norm) continue;
      const paths = Array.isArray(o.paths) ? o.paths.map(String) : [];
      out.push({
        id: norm.slug_or_path,
        sources: norm.sources,
        resolution: norm.resolution,
        paths,
      });
    }
    return out;
  }
  return [];
}

function buildCatalogSlots(dataDir?: string | null): Map<string, { category: string; peers: string[] }> {
  const catalog = loadKitCatalog(dataDir);
  const cats = (catalog.addon_categories ?? {}) as Record<
    string,
    { rule?: string; replaces_slot?: string; sources?: Array<{ name?: string }> }
  >;
  const map = new Map<string, { category: string; peers: string[] }>();
  for (const [catId, cat] of Object.entries(cats)) {
    if (cat.rule !== "pick_one") continue;
    const peers = (cat.sources ?? [])
      .map((s) => (s.name != null ? String(s.name) : ""))
      .filter(Boolean);
    const slot = cat.replaces_slot ?? catId;
    for (const name of peers) {
      map.set(name, { category: catId, peers: peers.filter((p) => p !== name) });
      // also record slot via category for lookups
      void slot;
    }
  }
  return map;
}

function loadInteractionGraph(options?: { dataDir?: string | null }): InteractionGraph {
  return {
    bySource: loadAllCompatibility(options?.dataDir),
    catalogSlots: buildCatalogSlots(options?.dataDir),
    mergeConflicts: loadMergeConflicts(options?.dataDir),
  };
}

function catalogSlotForSource(
  catalogSlots: Map<string, { category: string; peers: string[] }>,
  sourceName: string,
  dataDir?: string | null,
): { category: string; slot: string; peers: string[] } | null {
  const entry = catalogSlots.get(sourceName);
  if (!entry) return null;
  const catalog = loadKitCatalog(dataDir);
  const cats = (catalog.addon_categories ?? {}) as Record<
    string,
    { replaces_slot?: string }
  >;
  const slot = cats[entry.category]?.replaces_slot ?? entry.category;
  return { category: entry.category, slot, peers: entry.peers };
}

export function explainSource(
  sourceName: string,
  options?: { dataDir?: string | null; graph?: InteractionGraph },
): SourceExplanation | null {
  const graph = options?.graph ?? loadInteractionGraph({ dataDir: options?.dataDir });
  const compat = graph.bySource.get(sourceName);
  // Fuzzy: case-insensitive
  const resolved =
    compat ??
    [...graph.bySource.values()].find(
      (c) => c.source_name.toLowerCase() === sourceName.toLowerCase(),
    );
  if (!resolved && !graph.catalogSlots.has(sourceName)) {
    // try catalog-only
    const cat = catalogSlotForSource(graph.catalogSlots, sourceName, options?.dataDir);
    if (!cat) return null;
    return {
      source_name: sourceName,
      kind: null,
      attaches_to_bases: [],
      conflicts_with: cat.peers,
      not_for: [],
      replaces_slots: [cat.slot],
      replaces_parts: [],
      replaces: [],
      catalog_category: cat.category,
      catalog_slot: cat.slot,
      merge_conflict_ids: [],
    };
  }
  const name = resolved?.source_name ?? sourceName;
  const cat = catalogSlotForSource(graph.catalogSlots, name, options?.dataDir);
  const mergeIds = graph.mergeConflicts
    .filter((m) => {
      const hay = `${m.id} ${m.sources.join(" ")} ${m.resolution}`.toLowerCase();
      return hay.includes(name.toLowerCase()) || (resolved?.conflicts_with ?? []).some((c) =>
        hay.includes(c.toLowerCase()),
      );
    })
    .map((m) => m.id);

  const conflicts = new Set([
    ...(resolved?.conflicts_with ?? []),
    ...(cat?.peers ?? []),
  ]);

  return {
    source_name: name,
    kind: resolved?.kind ?? null,
    attaches_to_bases: resolved?.attaches_to_bases ?? [],
    conflicts_with: [...conflicts],
    not_for: resolved?.not_for ?? [],
    replaces_slots: [
      ...new Set([...(resolved?.replaces_slots ?? []), ...(cat ? [cat.slot] : [])]),
    ],
    replaces_parts: resolved?.replaces_parts ?? [],
    replaces: resolved?.replaces ?? [],
    catalog_category: cat?.category ?? null,
    catalog_slot: cat?.slot ?? null,
    merge_conflict_ids: mergeIds,
  };
}

function slotsOccupied(
  layerSourceNames: string[],
  options?: { dataDir?: string | null; graph?: InteractionGraph },
): Record<string, string[]> {
  const graph = options?.graph ?? loadInteractionGraph({ dataDir: options?.dataDir });
  const slots: Record<string, string[]> = {};
  for (const name of layerSourceNames) {
    const explained = explainSource(name, { graph });
    if (!explained) continue;
    for (const slot of explained.replaces_slots) {
      if (!slots[slot]) slots[slot] = [];
      slots[slot]!.push(explained.source_name);
    }
  }
  return slots;
}

function basenameHint(pathOrSlug: string): string {
  const cleaned = pathOrSlug.replace(/\\/g, "/");
  const base = cleaned.split("/").pop() ?? cleaned;
  return base.toLowerCase();
}

export function replacementsWhenAdding(
  addonSourceName: string,
  currentLayers: string[],
  options?: { dataDir?: string | null; graph?: InteractionGraph },
): {
  warnings: InteractionWarning[];
  suggested_excludes: string[];
  conflicts: Array<{ a: string; b: string; reason: string }>;
} {
  const graph = options?.graph ?? loadInteractionGraph({ dataDir: options?.dataDir });
  const addon = explainSource(addonSourceName, { graph });
  const warnings: InteractionWarning[] = [];
  const suggested_excludes: string[] = [];
  const conflicts: Array<{ a: string; b: string; reason: string }> = [];

  if (!addon) {
    return { warnings, suggested_excludes, conflicts };
  }

  const layerSet = new Set(currentLayers.map((s) => s.trim()).filter(Boolean));

  for (const peer of addon.conflicts_with) {
    if (layerSet.has(peer) || [...layerSet].some((l) => l.toLowerCase() === peer.toLowerCase())) {
      const msg = `"${addon.source_name}" conflicts with "${peer}" (pick one).`;
      warnings.push({
        severity: "warning",
        code: "compat_conflict",
        message: msg,
        sources: [addon.source_name, peer],
      });
      conflicts.push({ a: addon.source_name, b: peer, reason: "conflicts_with" });
    }
  }

  // Slot occupancy
  const occupied = slotsOccupied([...layerSet], { graph });
  for (const slot of addon.replaces_slots) {
    const holders = (occupied[slot] ?? []).filter(
      (h) => h.toLowerCase() !== addon.source_name.toLowerCase(),
    );
    if (holders.length) {
      warnings.push({
        severity: "warning",
        code: "compat_slot",
        message: `Slot "${slot}" already occupied by ${holders.join(", ")}; adding ${addon.source_name} may require removing them.`,
        sources: [addon.source_name, ...holders],
        slot,
      });
      for (const h of holders) {
        conflicts.push({ a: addon.source_name, b: h, reason: `slot:${slot}` });
      }
    }
  }

  // not_for bases
  for (const base of addon.not_for) {
    const hit = [...layerSet].find(
      (l) => l.toLowerCase() === base.toLowerCase() || base.toLowerCase().includes(l.toLowerCase()),
    );
    if (hit) {
      warnings.push({
        severity: "warning",
        code: "compat_not_for",
        message: `"${addon.source_name}" is marked not_for ${base} (plan has ${hit}).`,
        sources: [addon.source_name, hit],
      });
    }
  }

  for (const part of addon.replaces_parts) {
    const hint = basenameHint(part.from_slug_or_path);
    if (hint && !suggested_excludes.includes(hint)) {
      suggested_excludes.push(hint);
    }
    if (part.to_slug_or_path) {
      warnings.push({
        severity: "info",
        code: "compat_replace_part",
        message: `${addon.source_name} suggests replacing ${part.from_slug_or_path} → ${part.to_slug_or_path}`,
        sources: [addon.source_name],
      });
    } else if (part.from_slug_or_path) {
      warnings.push({
        severity: "info",
        code: "compat_replace_part",
        message: `${addon.source_name} suggests excluding/replacing ${part.from_slug_or_path}`,
        sources: [addon.source_name],
      });
    }
  }

  // Global merge conflict hints
  for (const mc of graph.mergeConflicts) {
    const mentionsAddon =
      mc.id.toLowerCase().includes(addon.source_name.toLowerCase()) ||
      mc.sources.some((s) => s.toLowerCase().includes(addon.source_name.toLowerCase())) ||
      mc.resolution.toLowerCase().includes(addon.source_name.toLowerCase());
    if (!mentionsAddon) continue;
    const otherOnPlan = [...layerSet].some((l) =>
      `${mc.sources.join(" ")} ${mc.resolution}`.toLowerCase().includes(l.toLowerCase()),
    );
    if (otherOnPlan || layerSet.size) {
      warnings.push({
        severity: "info",
        code: "merge_conflict_curated",
        message: `${mc.id}: ${mc.resolution.slice(0, 160)}`,
        sources: [addon.source_name],
        conflict_id: mc.id,
      });
    }
  }

  return { warnings, suggested_excludes, conflicts };
}

export function conflictsForStack(
  layerSourceNames: string[],
  options?: { dataDir?: string | null; graph?: InteractionGraph },
): StackCompatibilityResult {
  const graph = options?.graph ?? loadInteractionGraph({ dataDir: options?.dataDir });
  const layers = [...new Set(layerSourceNames.map((s) => s.trim()).filter(Boolean))];
  const warnings: InteractionWarning[] = [];
  const suggested_excludes: string[] = [];
  const conflicts: Array<{ a: string; b: string; reason: string }> = [];
  const occupied = slotsOccupied(layers, { graph });

  // Pairwise conflicts
  for (let i = 0; i < layers.length; i++) {
    for (let j = i + 1; j < layers.length; j++) {
      const a = layers[i]!;
      const b = layers[j]!;
      const ea = explainSource(a, { graph });
      const eb = explainSource(b, { graph });
      if (ea?.conflicts_with.some((c) => c.toLowerCase() === b.toLowerCase())) {
        warnings.push({
          severity: "warning",
          code: "compat_conflict",
          message: `"${a}" conflicts with "${b}".`,
          sources: [a, b],
        });
        conflicts.push({ a, b, reason: "conflicts_with" });
      } else if (eb?.conflicts_with.some((c) => c.toLowerCase() === a.toLowerCase())) {
        warnings.push({
          severity: "warning",
          code: "compat_conflict",
          message: `"${b}" conflicts with "${a}".`,
          sources: [a, b],
        });
        conflicts.push({ a, b, reason: "conflicts_with" });
      }
    }
  }

  for (const [slot, holders] of Object.entries(occupied)) {
    if (holders.length > 1) {
      warnings.push({
        severity: "warning",
        code: "compat_slot",
        message: `Slot "${slot}" has multiple occupants: ${holders.join(", ")}.`,
        sources: holders,
        slot,
      });
      for (let i = 0; i < holders.length; i++) {
        for (let j = i + 1; j < holders.length; j++) {
          conflicts.push({ a: holders[i]!, b: holders[j]!, reason: `slot:${slot}` });
        }
      }
    }
  }

  for (const name of layers) {
    const explained = explainSource(name, { graph });
    if (!explained) continue;
    for (const part of explained.replaces_parts) {
      const hint = basenameHint(part.from_slug_or_path);
      if (hint && !suggested_excludes.includes(hint)) suggested_excludes.push(hint);
    }
  }

  for (const mc of graph.mergeConflicts) {
    const involved = layers.filter((l) => {
      const hay = `${mc.id} ${mc.sources.join(" ")} ${mc.resolution}`.toLowerCase();
      return hay.includes(l.toLowerCase());
    });
    // probe_slot style: multiple known probe sources
    if (mc.id === "probe_slot") {
      const probes = layers.filter((l) =>
        /tap|klicky|boop/i.test(l),
      );
      if (probes.length > 1) {
        warnings.push({
          severity: "warning",
          code: "merge_conflict_curated",
          message: `${mc.id}: ${mc.resolution}`,
          sources: probes,
          conflict_id: mc.id,
        });
      }
    } else if (involved.length >= 2) {
      warnings.push({
        severity: "info",
        code: "merge_conflict_curated",
        message: `${mc.id}: ${mc.resolution.slice(0, 160)}`,
        sources: involved,
        conflict_id: mc.id,
      });
    }
  }

  return {
    layers,
    warnings,
    suggested_excludes,
    conflicts,
    slots_occupied: occupied,
  };
}

import { importRulesForProject, resolveSourceCategory } from "@print-partner/domain";

export type KitBundleProjectRow = {
  name: string;
  url: string;
  branch: string | null;
  tag: string | null;
  sourceKind: string | null;
  sourceType: string | null;
  role: string | null;
  importedPaths: string | null;
  metadataJson: string | null;
  manifestCommunitySlug: string | null;
};

export type KitBundleSourceRef = {
  name: string;
  url: string;
  branch: string;
  tag: string | null;
  source_kind: string;
  source_type: string;
  role: string;
  category: string;
  import_rules: string[];
  manifest_community_slug: string | null;
  /** Layer slot this source filled in the shared plan, when known (base/addon). */
  layer_type?: string;
};

export type KitBundleUnmatchedSource = {
  name: string;
  url: string;
  branch: string;
  tag: string | null;
  source_kind: string;
  role: string;
  import_rules: string[];
  manifest_community_slug?: string | null;
  /** Which layer slot to re-attach this source to on import (base/addon). */
  layer_type: string;
};

function rulesFromRaw(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => String(r)).filter(Boolean);
}

function sourceRefKey(entry: Pick<KitBundleSourceRef, "name" | "url">): string {
  const url = entry.url.trim().toLowerCase();
  if (url) return `url:${url}`;
  const name = entry.name.trim().toLowerCase();
  if (name) return `name:${name}`;
  return "";
}

function mergeSourceRefs(
  existing: KitBundleSourceRef,
  incoming: KitBundleSourceRef,
): KitBundleSourceRef {
  const importRules = [...existing.import_rules];
  for (const rule of incoming.import_rules) {
    if (!importRules.includes(rule)) importRules.push(rule);
  }
  return {
    name: existing.name || incoming.name,
    url: existing.url || incoming.url,
    branch: existing.branch || incoming.branch,
    tag: existing.tag || incoming.tag,
    source_kind: existing.source_kind || incoming.source_kind,
    source_type: existing.source_type || incoming.source_type,
    role: existing.role !== "unassigned" ? existing.role : incoming.role,
    category: existing.category !== "unassigned" ? existing.category : incoming.category,
    import_rules: importRules,
    manifest_community_slug:
      existing.manifest_community_slug ?? incoming.manifest_community_slug,
    layer_type:
      existing.layer_type === "base" || incoming.layer_type === "base"
        ? "base"
        : existing.layer_type ?? incoming.layer_type,
  };
}

export function kitSourceRefFromProject(proj: KitBundleProjectRow): KitBundleSourceRef {
  const rules = importRulesForProject(proj.importedPaths);
  const category = resolveSourceCategory(proj.metadataJson, proj.role);
  return {
    name: proj.name,
    url: proj.url,
    branch: proj.branch ?? "main",
    tag: proj.tag ?? null,
    source_kind: proj.sourceKind ?? "github",
    source_type: proj.sourceType ?? "git",
    role: proj.role ?? "unassigned",
    category: category ?? "unassigned",
    import_rules: rules ?? [],
    manifest_community_slug: proj.manifestCommunitySlug ?? null,
  };
}

export function kitSourceRefFromRecord(raw: Record<string, unknown>): KitBundleSourceRef | null {
  const name = String(raw.name ?? "").trim();
  const url = String(raw.url ?? "").trim();
  if (!name && !url) return null;
  const category = String(raw.category ?? raw.role ?? "unassigned").trim() || "unassigned";
  const slugRaw = raw.manifest_community_slug;
  const manifestSlug =
    typeof slugRaw === "string" && slugRaw.trim() ? slugRaw.trim() : null;
  const tagRaw = raw.tag;
  const tag = typeof tagRaw === "string" && tagRaw.trim() ? tagRaw.trim() : null;
  return {
    name,
    url,
    branch: String(raw.branch ?? "main").trim() || "main",
    tag,
    source_kind: String(raw.source_kind ?? "github").trim() || "github",
    source_type: String(raw.source_type ?? "git").trim() || "git",
    role: String(raw.role ?? category).trim() || category,
    category,
    import_rules: rulesFromRaw(raw.import_rules),
    manifest_community_slug: manifestSlug,
  };
}

export function kitSourceRefToExportRecord(ref: KitBundleSourceRef): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: ref.name,
    url: ref.url,
    branch: ref.branch,
    source_kind: ref.source_kind,
    source_type: ref.source_type,
    role: ref.role,
    category: ref.category,
    import_rules: ref.import_rules,
  };
  if (ref.tag) {
    out.tag = ref.tag;
  }
  if (ref.manifest_community_slug) {
    out.manifest_community_slug = ref.manifest_community_slug;
  }
  return out;
}

export function kitLayerProjectExportRecord(ref: KitBundleSourceRef): Record<string, unknown> {
  return kitSourceRefToExportRecord(ref);
}

/** Merge explicit `sources` entries with per-layer project refs for import. */
export function collectKitBundleSourceRefs(
  data: Record<string, unknown>,
): KitBundleSourceRef[] {
  const byKey = new Map<string, KitBundleSourceRef>();

  const add = (raw: Record<string, unknown>, layerType?: string) => {
    const ref = kitSourceRefFromRecord(raw);
    if (!ref) return;
    if (layerType) ref.layer_type = layerType;
    const key = sourceRefKey(ref);
    if (!key) return;
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeSourceRefs(existing, ref) : ref);
  };

  for (const entry of (data.sources as Array<Record<string, unknown>>) ?? []) {
    if (entry && typeof entry === "object") add(entry);
  }

  for (const layer of (data.layers as Array<Record<string, unknown>>) ?? []) {
    const project = layer.project;
    if (project && typeof project === "object") {
      add(project as Record<string, unknown>, String(layer.layer_type ?? "addon"));
    }
  }

  return [...byKey.values()];
}

export function kitUnmatchedSourceFromRef(ref: KitBundleSourceRef): KitBundleUnmatchedSource {
  return {
    name: ref.name,
    url: ref.url,
    branch: ref.branch,
    tag: ref.tag,
    source_kind: ref.source_kind,
    role: ref.category !== "unassigned" ? ref.category : ref.role,
    import_rules: ref.import_rules,
    layer_type: ref.layer_type ?? "addon",
    ...(ref.manifest_community_slug
      ? { manifest_community_slug: ref.manifest_community_slug }
      : {}),
  };
}

export function kitMatchedSourcePatch(
  ref: KitBundleSourceRef,
): {
  branch?: string;
  tag?: string | null;
  source_kind?: string;
  role?: string;
  manifest_community_slug?: string | null;
} {
  const patch: {
    branch?: string;
    tag?: string | null;
    source_kind?: string;
    role?: string;
    manifest_community_slug?: string | null;
  } = {};
  if (ref.branch) patch.branch = ref.branch;
  if (ref.tag) patch.tag = ref.tag;
  if (ref.source_kind) patch.source_kind = ref.source_kind;
  const role = ref.category !== "unassigned" ? ref.category : ref.role;
  if (role && role !== "unassigned") patch.role = role;
  if (ref.manifest_community_slug) {
    patch.manifest_community_slug = ref.manifest_community_slug;
  }
  return patch;
}

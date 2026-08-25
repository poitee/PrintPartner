/**
 * Name vocabulary for guide ingest and prose→proposal recovery.
 *
 * Everything here is derived from tenant data — the kit catalog and the live
 * source list — so no project family is baked into code. A deployment that
 * ships an empty catalog and has no sources yet gets an empty vocabulary, and
 * the heuristics that consume it simply resolve nothing.
 */

export type VocabularyEntry = {
  /** Canonical `source_name` to propose. */
  name: string;
  /** Lower-cased alternate spellings (catalog ids, variant ids, labels). */
  aliases: string[];
};

export type KitVocabulary = {
  bases: VocabularyEntry[];
  addons: VocabularyEntry[];
  /** Git refs worth recognising in guide text (catalog tags + universal defaults). */
  refs: string[];
};

/** Branch names every git host uses — safe to recognise without catalog data. */
export const UNIVERSAL_GIT_REFS = ["main", "master"] as const;

export const EMPTY_KIT_VOCABULARY: KitVocabulary = {
  bases: [],
  addons: [],
  refs: [...UNIVERSAL_GIT_REFS],
};

function cleanAlias(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  // Single letters / digits match far too much to be useful as an alias.
  return trimmed.length >= 3 ? trimmed : null;
}

function addEntry(
  into: Map<string, VocabularyEntry>,
  name: unknown,
  aliases: unknown[],
): void {
  if (typeof name !== "string") return;
  const canonical = name.trim();
  if (!canonical) return;
  const existing = into.get(canonical) ?? { name: canonical, aliases: [] };
  for (const raw of aliases) {
    const alias = cleanAlias(raw);
    if (alias && alias !== canonical.toLowerCase() && !existing.aliases.includes(alias)) {
      existing.aliases.push(alias);
    }
  }
  into.set(canonical, existing);
}

type CatalogBase = { label?: string; source_name?: string };
type CatalogAddonSource = { name?: string; variant_id?: string; label?: string };
type CatalogCategory = { sources?: CatalogAddonSource[] };
type CatalogPreset = { base_tag?: string | null };

/**
 * Build the vocabulary from a kit catalog and the tenant's synced sources.
 *
 * Catalog entries come first so their canonical `source_name` wins; live sources
 * fill in anything the catalog does not describe. Live sources are offered as
 * both base and addon candidates because only the guide text can say which role
 * a repo plays.
 */
export function buildKitVocabulary(input: {
  catalog?: Record<string, unknown> | null;
  sourceNames?: readonly string[];
}): KitVocabulary {
  const catalog = input.catalog ?? {};
  const bases = new Map<string, VocabularyEntry>();
  const addons = new Map<string, VocabularyEntry>();
  const refs = new Set<string>(UNIVERSAL_GIT_REFS);

  const catalogBases = (catalog.bases ?? {}) as Record<string, CatalogBase>;
  for (const [id, base] of Object.entries(catalogBases)) {
    addEntry(bases, base?.source_name, [id, base?.label]);
  }

  const categories = (catalog.addon_categories ?? {}) as Record<string, CatalogCategory>;
  for (const category of Object.values(categories)) {
    for (const source of category?.sources ?? []) {
      addEntry(addons, source?.name, [source?.variant_id, source?.label]);
    }
  }

  const presets = (catalog.stack_presets ?? {}) as Record<string, CatalogPreset>;
  for (const preset of Object.values(presets)) {
    const tag = typeof preset?.base_tag === "string" ? preset.base_tag.trim() : "";
    if (tag) refs.add(tag);
  }

  for (const name of input.sourceNames ?? []) {
    addEntry(bases, name, []);
    addEntry(addons, name, []);
  }

  return {
    bases: [...bases.values()],
    addons: [...addons.values()],
    refs: [...refs],
  };
}

/** Flatten a vocabulary side to canonical names (for prompts and messages). */
export function vocabularyNames(entries: readonly VocabularyEntry[]): string[] {
  return entries.map((e) => e.name);
}

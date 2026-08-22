/** User-managed source library categories (ported from Python source_categories.py). */

export const SOURCE_CATEGORIES_KEY = "source_categories";

export const DEFAULT_SOURCE_CATEGORIES = [
  "Printer kits",
  "Toolheads",
  "Probes & sensors",
  "Mods",
  "Hardware",
  "Other",
] as const;

const ROLE_TO_CATEGORY: Record<string, string | null> = {
  base: "Printer kits",
  addon: "Mods",
  unassigned: null,
};

export function loadSourceCategories(raw: string | null | undefined): string[] {
  if (!raw) return [...DEFAULT_SOURCE_CATEGORIES];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_SOURCE_CATEGORIES];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const name = item.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out.length ? out : [...DEFAULT_SOURCE_CATEGORIES];
  } catch {
    return [...DEFAULT_SOURCE_CATEGORIES];
  }
}

export function normalizeSourceCategories(categories: string[]): string[] {
  if (!categories.length) throw new Error("At least one category is required");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of categories) {
    if (typeof item !== "string") throw new Error("Each category must be a string");
    const name = item.trim();
    if (!name) throw new Error("Category names cannot be empty");
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (!out.length) throw new Error("At least one category is required");
  return out;
}

export function parseProjectMetadata(metadataJson: string | null | undefined): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw: metadataJson };
  } catch {
    return { raw: metadataJson };
  }
}

/**
 * Resolve the library category for a source.
 *
 * Single category per source. When `metadata.category` is present (including
 * empty string / null), that value wins so Uncategorised can be set explicitly.
 * When the key is absent, fall back to legacy role → category mapping.
 */
export function resolveSourceCategory(
  metadataJson: string | null | undefined,
  role: string | null | undefined,
): string | null {
  const metadata = parseProjectMetadata(metadataJson);
  if (metadata && "category" in metadata) {
    const raw = metadata.category;
    if (typeof raw === "string") {
      const stripped = raw.trim();
      return stripped || null;
    }
    return null;
  }
  const r = (role ?? "unassigned").trim().toLowerCase();
  return ROLE_TO_CATEGORY[r] ?? null;
}

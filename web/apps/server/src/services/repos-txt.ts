import type { AppRepository } from "../db/repository.js";
import { loadKitCatalog } from "./kit-catalog.js";

const GITHUB_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

export type ReposTxtLine = {
  name: string;
  url: string;
  branch: string;
};

export type CatalogSuggestion = {
  role: string;
  metadata: Record<string, unknown>;
};

export type ImportReposTxtResult = {
  created: number;
  updated: number;
  skipped: number;
  skipped_names: string[];
  results: Array<{
    name: string;
    action: "created" | "updated";
    role?: string;
    source_id?: number;
  }>;
};

export function parseReposTxtLine(line: string): ReposTxtLine | null {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length >= 2) {
    const [name, url] = parts;
    if (!name) return null;
    const branch = parts.length > 2 ? parts[2] || "main" : "main";
    if (url.toLowerCase() === "none" || url.toLowerCase() === "null" || url === "") {
      return null;
    }
    return { name, url, branch: branch || "main" };
  }
  const match = GITHUB_URL_RE.exec(raw);
  if (match) {
    return { name: match[2], url: raw, branch: "main" };
  }
  return null;
}

export function parseReposTxtText(text: string): ReposTxtLine[] {
  const rows: ReposTxtLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseReposTxtLine(line);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

export function suggestFromCatalog(
  sourceName: string,
  catalog?: Record<string, unknown>,
): CatalogSuggestion | null {
  const cat = catalog ?? loadKitCatalog();
  const bases = cat.bases as Record<string, { source_name?: string }> | undefined;
  if (bases) {
    for (const base of Object.values(bases)) {
      if (base.source_name === sourceName) {
        return { role: "base", metadata: {} };
      }
    }
  }
  const addonCategories = cat.addon_categories as
    | Record<
        string,
        {
          sources?: Array<{ name: string; compatible_bases?: string[] }>;
        }
      >
    | undefined;
  if (addonCategories) {
    for (const [catId, category] of Object.entries(addonCategories)) {
      for (const entry of category.sources ?? []) {
        if (entry.name === sourceName) {
          const kit: Record<string, unknown> = { addon_category: catId };
          if (entry.compatible_bases?.length) {
            kit.compatible_bases = [...entry.compatible_bases];
          }
          return { role: "addon", metadata: { kit } };
        }
      }
    }
  }
  return null;
}

function mergeMetadata(
  existing: Record<string, unknown> | null,
  suggestion: CatalogSuggestion | null,
): Record<string, unknown> | null {
  if (!suggestion) return existing;
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  if (suggestion.role === "base") return Object.keys(base).length ? base : null;
  const kit = base.kit;
  if (kit && typeof kit === "object" && (kit as Record<string, unknown>).addon_category) {
    return Object.keys(base).length ? base : null;
  }
  const merged = { ...base, ...suggestion.metadata };
  return Object.keys(merged).length ? merged : null;
}

export function importReposTxt(
  repo: AppRepository,
  text: string,
  catalog?: Record<string, unknown>,
): ImportReposTxtResult {
  const cat = catalog ?? loadKitCatalog();
  const lines = parseReposTxtText(text);
  let created = 0;
  let updated = 0;
  const skippedNames: string[] = [];
  const results: ImportReposTxtResult["results"] = [];

  for (const row of lines) {
    const suggestion = suggestFromCatalog(row.name, cat);
    const existing = repo.listSources().find((s) => s.name === row.name);

    if (existing) {
      const patch: Parameters<AppRepository["updateSource"]>[1] = {
        url: row.url,
        branch: row.branch,
      };
      if (suggestion) {
        const merged = mergeMetadata(existing.metadata ?? null, suggestion);
        if (merged) patch.metadata = merged;
        if (suggestion.role && (existing.role || "unassigned") === "unassigned") {
          patch.role = suggestion.role;
        }
      }
      repo.updateSource(existing.id, patch);
      updated += 1;
      results.push({ name: row.name, action: "updated", source_id: existing.id });
      continue;
    }

    let role = "unassigned";
    let metadata: Record<string, unknown> | undefined;
    if (suggestion) {
      role = suggestion.role;
      const merged = mergeMetadata(null, suggestion);
      if (merged) metadata = merged;
    }

    const source = repo.createSource({
      name: row.name,
      url: row.url,
      branch: row.branch,
      source_kind: "github",
      source_type: "git",
      role,
      metadata,
    });
    created += 1;
    results.push({ name: row.name, action: "created", role, source_id: source.id });
  }

  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = raw.split(",").map((p) => p.trim());
    if (parts.length >= 2) {
      const url = parts[1].toLowerCase();
      if (url === "none" || url === "null" || parts[1] === "") {
        skipped += 1;
        skippedNames.push(parts[0]);
      }
    }
  }

  return { created, updated, skipped, skipped_names: skippedNames, results };
}

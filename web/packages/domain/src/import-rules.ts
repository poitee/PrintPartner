/** Project-level STL import rules (ported from Python import_rules.py). */

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").trim().replace(/^\/+/, "");
}

export function normalizeRule(rule: string): string {
  const r = normalizeRelativePath(rule);
  if (!r) return r;
  if (r.endsWith("/")) return r;
  if (r.toLowerCase().endsWith(".stl")) return r;
  return `${r}/`;
}

export function parseImportRulesJson(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const data = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(data)) return [];
    const rules: string[] = [];
    for (const item of data) {
      if (typeof item === "string" && item.trim()) {
        rules.push(normalizeRule(item));
      }
    }
    return rules;
  } catch {
    return [];
  }
}

export function serializeImportRules(rules: string[] | null): string | null {
  if (rules == null) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const r = normalizeRule(rule);
    if (r && !seen.has(r)) {
      seen.add(r);
      normalized.push(r);
    }
  }
  return JSON.stringify(normalized);
}

export function pathMatchesRules(relativePath: string, rules: string[]): boolean {
  if (!rules.length) return false;
  const norm = normalizeRelativePath(relativePath);
  for (const rule of rules) {
    if (rule.endsWith("/")) {
      const prefix = rule.slice(0, -1);
      if (norm === prefix || norm.startsWith(`${prefix}/`)) return true;
    } else if (norm === rule) {
      return true;
    }
  }
  return false;
}

export function compressRulesFromFiles(checkedFiles: Iterable<string>): string[] {
  const allFiles = new Set(checkedFiles);
  if (allFiles.size === 0) return [];

  const dirPrefixes = new Set<string>();
  for (const f of allFiles) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirPrefixes.add(parts.slice(0, i).join("/"));
    }
  }

  const rules: string[] = [];
  const used = new Set<string>();

  for (const prefix of [...dirPrefixes].sort(
    (a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b),
  )) {
    const prefixFiles = [...allFiles].filter((f) => f.startsWith(`${prefix}/`));
    if (!prefixFiles.length) continue;
    if (prefixFiles.every((f) => used.has(f))) continue;
    if (prefixFiles.every((f) => allFiles.has(f))) {
      rules.push(normalizeRule(`${prefix}/`));
      for (const f of prefixFiles) used.add(f);
    }
  }

  for (const f of [...allFiles].sort()) {
    if (!used.has(f)) rules.push(f);
  }
  return rules;
}

export function importRulesForProject(importedPathsRaw: string | null | undefined): string[] | null {
  return parseImportRulesJson(importedPathsRaw ?? null);
}

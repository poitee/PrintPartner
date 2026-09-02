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

export function importRulesForProject(importedPathsRaw: string | null | undefined): string[] | null {
  return parseImportRulesJson(importedPathsRaw ?? null);
}

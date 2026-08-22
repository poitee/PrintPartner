import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { matchKeyMatches, mergeOptionGroups, type ManifestOptionGroup } from "./manifest-apply.js";

type PathHintRule = {
  path: string;
  option_group?: string;
  variant_id?: string;
  label?: string;
};

let cachedRules: PathHintRule[] | null = null;

function loadPathHintRules(): PathHintRule[] {
  if (cachedRules) return cachedRules;
  const serviceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(serviceDir, "../data/path-hints.yaml"),
    join(serviceDir, "../../src/data/path-hints.yaml"),
    join(serviceDir, "../../../docs/path-hints.yaml"),
  ];
  for (const file of candidates) {
    try {
      const raw = yaml.load(readFileSync(file, "utf8")) as { rules?: PathHintRule[] };
      cachedRules = Array.isArray(raw.rules) ? raw.rules : [];
      return cachedRules;
    } catch {
      /* try next */
    }
  }
  cachedRules = [];
  return cachedRules;
}

/** Infer option groups from scanned STL paths when a repo has no manifest YAML. */
export function inferOptionGroupsFromPaths(
  scannedPaths: string[],
): Record<string, ManifestOptionGroup> {
  const groups: Record<string, ManifestOptionGroup> = {};
  for (const rule of loadPathHintRules()) {
    if (!rule.option_group || !rule.variant_id) continue;
    const matched = scannedPaths.some((p) => matchKeyMatches(rule.path, p));
    if (!matched) continue;
    const gid = rule.option_group;
    const incoming: Record<string, ManifestOptionGroup> = {
      [gid]: {
        rule: "pick_one",
        label: rule.label ?? gid.replace(/_/g, " "),
        parts: [],
        variants: [
          {
            id: rule.variant_id,
            label: rule.label ?? rule.variant_id.replace(/_/g, " "),
            parts: [rule.path],
          },
        ],
      },
    };
    mergeOptionGroups(groups, incoming);
  }
  return groups;
}

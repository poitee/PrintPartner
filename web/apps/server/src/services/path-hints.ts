import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { matchKeyMatches, mergeOptionGroups, type ManifestOptionGroup } from "./manifest-apply.js";

type PathHintRule = {
  path: string;
  option_group: string;
  variant_id: string;
  label?: string;
};

const PATH_HINT_DOCUMENT_FIELDS = new Set(["version", "rules"]);
const PATH_HINT_RULE_FIELDS = new Set(["path", "option_group", "variant_id", "label"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  value: unknown,
  field: string,
  file: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${file}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertSupportedFields(
  value: Record<string, unknown>,
  supported: ReadonlySet<string>,
  prefix: string,
  file: string,
): void {
  for (const field of Object.keys(value)) {
    if (!supported.has(field)) {
      throw new Error(`${file}: ${prefix}${field} is not supported`);
    }
  }
}

function parsePathHintRule(value: unknown, index: number, file: string): PathHintRule {
  const prefix = `rules[${index}]`;
  if (!isRecord(value)) throw new Error(`${file}: ${prefix} must be a mapping`);
  assertSupportedFields(value, PATH_HINT_RULE_FIELDS, `${prefix}.`, file);
  const path = optionalString(value.path, `${prefix}.path`, file);
  if (!path) throw new Error(`${file}: ${prefix}.path must be a non-empty string`);
  const optionGroup = optionalString(value.option_group, `${prefix}.option_group`, file);
  if (!optionGroup) {
    throw new Error(`${file}: ${prefix}.option_group must be a non-empty string`);
  }
  const variantId = optionalString(value.variant_id, `${prefix}.variant_id`, file);
  if (!variantId) {
    throw new Error(`${file}: ${prefix}.variant_id must be a non-empty string`);
  }
  const label = optionalString(value.label, `${prefix}.label`, file);
  return {
    path,
    option_group: optionGroup,
    variant_id: variantId,
    ...(label === undefined ? {} : { label }),
  };
}

function readPathHintRules(file: string): PathHintRule[] {
  let document: unknown;
  try {
    document = yaml.load(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: could not read path hints: ${detail}`, { cause: error });
  }
  if (!isRecord(document)) throw new Error(`${file}: document must be a mapping`);
  assertSupportedFields(document, PATH_HINT_DOCUMENT_FIELDS, "", file);
  if (document.version !== 1) throw new Error(`${file}: version must be 1`);
  if (!Array.isArray(document.rules)) throw new Error(`${file}: rules must be an array`);
  return document.rules.map((rule, index) => parsePathHintRule(rule, index, file));
}

function tryReadShippedPathHintRules(file: string): PathHintRule[] | null {
  try {
    return readPathHintRules(file);
  } catch {
    return null;
  }
}

function loadShippedPathHintRules(): PathHintRule[] {
  const serviceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(serviceDir, "../data/path-hints.yaml"),
    join(serviceDir, "../../src/data/path-hints.yaml"),
    join(serviceDir, "../../../docs/path-hints.yaml"),
  ];
  for (const file of candidates) {
    const rules = tryReadShippedPathHintRules(file);
    if (rules) return rules;
  }
  return [];
}

function loadPathHintRules(dataDir: string | null): PathHintRule[] {
  const shipped = loadShippedPathHintRules();
  if (!dataDir) return shipped;
  const customFile = join(dataDir, "path-hints.yaml");
  if (!existsSync(customFile)) return shipped;
  return [...shipped, ...readPathHintRules(customFile)];
}

/** Infer option groups from scanned STL paths when a repo has no manifest YAML. */
export function inferOptionGroupsFromPaths(
  scannedPaths: string[],
  dataDir: string | null,
): Record<string, ManifestOptionGroup> {
  const groups: Record<string, ManifestOptionGroup> = {};
  for (const rule of loadPathHintRules(dataDir)) {
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

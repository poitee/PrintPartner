import type { AppRepository } from "../db/repository.js";
import {
  cloneManifestSelections,
  parseManifestSelections,
  type ManifestSelections,
} from "./manifest-selections.js";

export type KitManifestRecord = {
  name: string | null;
  layers: string[];
  base_source_id: string | null;
  addon_source_ids: string[];
  selections: ManifestSelections;
  include: string[];
  exclude: string[];
  replacements: Record<string, string>;
  choice_tree: unknown[];
  category_links: unknown[];
};

export const EMPTY_KIT_MANIFEST: KitManifestRecord = {
  name: null,
  layers: [],
  base_source_id: null,
  addon_source_ids: [],
  selections: {},
  include: [],
  exclude: [],
  replacements: {},
  choice_tree: [],
  category_links: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseNullableString(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${path} must be a string or null`);
  return value;
}

function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return [...value];
}

function parseStringRecord(value: unknown, path: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${path}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

export function parseKitManifestUpdate(raw: unknown): Partial<KitManifestRecord> {
  if (!isRecord(raw)) throw new Error("kit must be an object");
  const result: Partial<KitManifestRecord> = {};

  if ("name" in raw) result.name = parseNullableString(raw.name, "kit.name");
  if ("layers" in raw) result.layers = parseStringArray(raw.layers, "kit.layers");
  if ("base_source_id" in raw) {
    result.base_source_id = parseNullableString(raw.base_source_id, "kit.base_source_id");
  }
  if ("addon_source_ids" in raw) {
    result.addon_source_ids = parseStringArray(raw.addon_source_ids, "kit.addon_source_ids");
  }
  if ("selections" in raw) {
    result.selections = parseManifestSelections(raw.selections, "kit.selections");
  }
  if ("include" in raw) result.include = parseStringArray(raw.include, "kit.include");
  if ("exclude" in raw) result.exclude = parseStringArray(raw.exclude, "kit.exclude");
  if ("replacements" in raw) {
    result.replacements = parseStringRecord(raw.replacements, "kit.replacements");
  }
  if ("choice_tree" in raw) {
    if (!Array.isArray(raw.choice_tree)) throw new Error("kit.choice_tree must be an array");
    result.choice_tree = [...raw.choice_tree];
  }
  if ("category_links" in raw) {
    if (!Array.isArray(raw.category_links)) {
      throw new Error("kit.category_links must be an array");
    }
    result.category_links = [...raw.category_links];
  }

  return result;
}

export function kitManifestSettingKey(profileId: number): string {
  return `kit_manifest_${profileId}`;
}

export function loadKitManifest(repo: AppRepository, profileId: number): KitManifestRecord {
  const raw = repo.getSetting(kitManifestSettingKey(profileId));
  if (!raw) return { ...EMPTY_KIT_MANIFEST };
  try {
    const parsed: unknown = JSON.parse(raw);
    const update = parseKitManifestUpdate(parsed);
    return {
      ...EMPTY_KIT_MANIFEST,
      ...update,
      selections: cloneManifestSelections(update.selections ?? {}),
      replacements: { ...(update.replacements ?? {}) },
    };
  } catch {
    return { ...EMPTY_KIT_MANIFEST };
  }
}

export function saveKitManifest(
  repo: AppRepository,
  profileId: number,
  kit: Partial<KitManifestRecord>,
): KitManifestRecord {
  const merged: KitManifestRecord = {
    ...EMPTY_KIT_MANIFEST,
    ...kit,
    selections: parseManifestSelections(kit.selections ?? {}, "kit.selections"),
    replacements: { ...(kit.replacements ?? {}) },
  };
  repo.setSetting(kitManifestSettingKey(profileId), JSON.stringify(merged));
  repo.markProfileConfigModified(profileId);
  return merged;
}

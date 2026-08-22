import type { AppRepository } from "../db/repository.js";

export const EMPTY_KIT_MANIFEST = {
  name: null,
  layers: [] as string[],
  base_source_id: null,
  addon_source_ids: [] as string[],
  selections: {} as Record<string, string>,
  include: [] as string[],
  exclude: [] as string[],
  replacements: {} as Record<string, string>,
  choice_tree: [] as unknown[],
  category_links: [] as unknown[],
};

export type KitManifestRecord = typeof EMPTY_KIT_MANIFEST;

export function kitManifestSettingKey(profileId: number): string {
  return `kit_manifest_${profileId}`;
}

export function loadKitManifest(repo: AppRepository, profileId: number): KitManifestRecord {
  const raw = repo.getSetting(kitManifestSettingKey(profileId));
  if (!raw) return { ...EMPTY_KIT_MANIFEST };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...EMPTY_KIT_MANIFEST,
      ...parsed,
      selections:
        parsed.selections && typeof parsed.selections === "object"
          ? (parsed.selections as Record<string, string>)
          : {},
      replacements:
        parsed.replacements && typeof parsed.replacements === "object"
          ? (parsed.replacements as Record<string, string>)
          : {},
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
  const merged = { ...EMPTY_KIT_MANIFEST, ...kit };
  repo.setSetting(kitManifestSettingKey(profileId), JSON.stringify(merged));
  repo.markProfileConfigModified(profileId);
  return merged;
}

/**
 * Merge a single library category into source metadata.
 * Empty/null persists as `""` so Uncategorised stays explicit and does not fall back to role.
 */
export function mergeSourceMetadataCategory(
  metadata: Record<string, unknown> | undefined,
  category: string | null | undefined,
): Record<string, unknown> | undefined {
  if (category === undefined) return metadata;
  const base = { ...(metadata ?? {}) };
  base.category = category == null || category === "" ? "" : category;
  return base;
}

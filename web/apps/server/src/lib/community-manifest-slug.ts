/**
 * A community manifest slug names `<slug>.yaml` in the embedded manifests
 * directory, so it must be a single path segment.
 */
const COMMUNITY_MANIFEST_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL =
  "manifest_community_slug must be 1 to 64 lowercase letters, digits, dots, hyphens or underscores, starting with a letter or digit";

export class InvalidCommunityManifestSlugError extends Error {
  constructor() {
    super(INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL);
    this.name = "InvalidCommunityManifestSlugError";
  }
}

export function isCommunityManifestSlug(value: string): boolean {
  return COMMUNITY_MANIFEST_SLUG.test(value);
}

/** Trimmed slug, or null when absent or blank (no community manifest). */
export function parseCommunityManifestSlug(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new InvalidCommunityManifestSlugError();
  const slug = value.trim();
  if (!slug) return null;
  if (!isCommunityManifestSlug(slug)) throw new InvalidCommunityManifestSlugError();
  return slug;
}

/**
 * A community manifest slug names `<slug>.yaml` in the embedded manifests
 * directory, so it must be a single path segment. The reserved slugs keep
 * other documents in that directory from being read as community manifests:
 * `registry-index.yaml` ships there, and `kit-catalog.ts` also looks there for
 * a deployment-provided `kit-catalog.yaml` (the shipped one is in `src/data`).
 */
const COMMUNITY_MANIFEST_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_COMMUNITY_MANIFEST_SLUGS = new Set(["kit-catalog", "registry-index"]);

export const INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL =
  "manifest_community_slug must be 1 to 64 lowercase letters, digits, dots, hyphens or underscores, starting with a letter or digit, and not kit-catalog or registry-index";

export class InvalidCommunityManifestSlugError extends Error {
  constructor() {
    super(INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL);
    this.name = "InvalidCommunityManifestSlugError";
  }
}

export function isCommunityManifestSlug(value: string): boolean {
  return COMMUNITY_MANIFEST_SLUG.test(value) && !RESERVED_COMMUNITY_MANIFEST_SLUGS.has(value);
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

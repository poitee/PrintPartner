/**
 * Path safety for printer host storage.
 *
 * A printer host's file listing is untrusted network input even on a LAN, and
 * the paths it reports are fed straight back as URL segments. Both adapters
 * grew their own copy of this guard, so a fix to one silently left the other
 * exposed. There is one guard now.
 *
 * The rules come from the artifact research doc's "File and URL safety":
 * normalize segments, and reject traversal segments, NUL bytes, ambiguous
 * backslashes, and anything that escapes the selected provider root.
 */

export type StoragePathOptions = {
  /** Trim trailing slashes as well as leading ones. Directory paths need this. */
  readonly trimTrailing?: boolean;
};

/**
 * Normalize a host-reported path, or return null when it is not safe to use.
 *
 * A backslash is rejected rather than translated: only the host knows whether
 * it meant a separator or a literal, and guessing is how traversal slips through.
 */
export function safeStoragePath(
  raw: string,
  options: StoragePathOptions = {},
): string | null {
  if (raw.includes("\\") || raw.includes("\0")) return null;
  const normalized = options.trimTrailing
    ? raw.replace(/^\/+|\/+$/g, "")
    : raw.replace(/^\/+/, "");
  if (!normalized) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

/** Percent-encode each segment, leaving the separators intact. */
export function encodeStoragePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Join a provider root to a already-safe relative path.
 * Returns null when the result would escape the root.
 */
export function joinStoragePath(root: string, relative: string): string | null {
  const safeRoot = safeStoragePath(root, { trimTrailing: true });
  if (!safeRoot) return null;
  if (!relative) return safeRoot;
  const safeRelative = safeStoragePath(relative, { trimTrailing: true });
  if (!safeRelative) return null;
  return `${safeRoot}/${safeRelative}`;
}

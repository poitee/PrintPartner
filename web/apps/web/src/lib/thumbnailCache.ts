/**
 * Tiny external store for a global thumbnail cache-buster. Bumping the version
 * forces every mounted `PartThumb` to re-probe the server (and re-render the
 * STL client-side if the server cache was cleared), so freshly regenerated
 * colors show up without a full page reload.
 */
let version = 0;
const listeners = new Set<() => void>();

export function getThumbnailCacheVersion(): number {
  return version;
}

export function bumpThumbnailCache(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeThumbnailCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

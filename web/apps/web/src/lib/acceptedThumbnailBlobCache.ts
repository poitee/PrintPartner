const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export class AcceptedThumbnailBlobCache {
  readonly #entries = new Map<string, Blob>();
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Accepted thumbnail cache byte limit must be a positive integer");
    }
    this.#maxBytes = maxBytes;
  }

  get(basis: string): Blob | null {
    const blob = this.#entries.get(basis);
    if (!blob) return null;
    this.#entries.delete(basis);
    this.#entries.set(basis, blob);
    return blob;
  }

  set(basis: string, blob: Blob): void {
    const existing = this.#entries.get(basis);
    if (existing) {
      this.#entries.delete(basis);
      this.#bytes -= existing.size;
    }
    if (blob.size > this.#maxBytes) return;
    this.#entries.set(basis, blob);
    this.#bytes += blob.size;
    while (this.#bytes > this.#maxBytes) {
      const oldestBasis = this.#entries.keys().next().value;
      if (typeof oldestBasis !== "string") break;
      const oldest = this.#entries.get(oldestBasis);
      this.#entries.delete(oldestBasis);
      this.#bytes -= oldest?.size ?? 0;
    }
  }
}

export const acceptedThumbnailBlobCache = new AcceptedThumbnailBlobCache();

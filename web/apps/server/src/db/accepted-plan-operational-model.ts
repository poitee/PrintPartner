import { createHash } from "node:crypto";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const ACCEPTED_READ_PAGE_SIZE = 256;
export const ACCEPTED_TEXT_PAGE_SIZE = 16;
export const ACCEPTED_IN_LIST_SIZE = 64;

export function chunks<T>(items: readonly T[], size = ACCEPTED_IN_LIST_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function digestFormat1Inputs(
  rows: readonly { readonly sourceRevisionId: number; readonly manifestDigest: string }[],
): string {
  const canonical = [...rows]
    .map((row) => ({
      source_revision_id: row.sourceRevisionId,
      manifest_digest: row.manifestDigest,
    }))
    .sort((left, right) => left.source_revision_id - right.source_revision_id);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function isSafeLayerOrder(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isSafeRelativePath(value: string): boolean {
  const segments = value.split("/");
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

export function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function storedBoolean(value: unknown): boolean | null {
  if (value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  return null;
}

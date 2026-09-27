import type { ManifestSelection, ManifestSelections } from "@print-partner/contracts";

export const KIT_MANIFEST_SAVED_CLEAR_MS = 3000;

export function selectionsEqual(
  a: ManifestSelections,
  b: ManifestSelections,
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key, index) =>
      key === keysB[index] && selectionValuesEqual(a[key], b[key]),
  );
}

function selectionValuesEqual(
  a: ManifestSelection | undefined,
  b: ManifestSelection | undefined,
): boolean {
  if (a == null || b == null) return a === b;
  const idsA = [...(Array.isArray(a) ? a : [a])].sort();
  const idsB = [...(Array.isArray(b) ? b : [b])].sort();
  return idsA.length === idsB.length && idsA.every((id, index) => id === idsB[index]);
}

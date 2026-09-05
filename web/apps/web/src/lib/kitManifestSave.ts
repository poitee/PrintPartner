import type { ManifestSelection, ManifestSelections } from "@print-partner/contracts";

export type KitManifestSaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export const KIT_MANIFEST_AUTOSAVE_MS = 700;
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

export function kitManifestSaveStatusLabel(status: KitManifestSaveStatus): string | null {
  switch (status) {
    case "pending":
      return "Saving…";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return "Save failed — retry";
    default:
      return null;
  }
}

export function shouldShowKitManifestRetry(status: KitManifestSaveStatus): boolean {
  return status === "error";
}

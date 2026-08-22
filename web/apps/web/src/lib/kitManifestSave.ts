export type KitManifestSaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export const KIT_MANIFEST_AUTOSAVE_MS = 700;
export const KIT_MANIFEST_SAVED_CLEAR_MS = 3000;

export function selectionsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, i) => key === keysB[i] && a[key] === b[key]);
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

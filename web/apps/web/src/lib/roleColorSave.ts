export type RoleColorSaveStatus = "idle" | "saving" | "saved" | "error";

export const ROLE_COLOR_SAVED_CLEAR_MS = 500;

export function roleColorSaveStatusLabel(status: RoleColorSaveStatus): string | null {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return "Save failed";
    default:
      return null;
  }
}

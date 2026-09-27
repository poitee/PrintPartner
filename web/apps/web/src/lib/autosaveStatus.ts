export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export function autosaveStatusLabel(status: AutosaveStatus): string | null {
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

export function shouldShowAutosaveRetry(status: AutosaveStatus): boolean {
  return status === "error";
}

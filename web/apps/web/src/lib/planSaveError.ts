import { EngineHttpError } from "../api/engineTransport";
import { WorkingPlanChangedError } from "./workingPlanChanged";

export function planSaveHasMergeConflict(error: unknown): boolean {
  const original = error instanceof Error && error.cause instanceof EngineHttpError ? error.cause : error;
  return original instanceof EngineHttpError && original.body != null && typeof original.body === "object" && "code" in original.body && original.body.code === "merge_conflicts";
}

export function planSaveError(error: unknown): string {
  if (error instanceof WorkingPlanChangedError) {
    return "The Plan or source files changed in another window. Your edits have been combined with the latest files. Check the result and retry saving.";
  }
  if (error instanceof EngineHttpError && error.body && typeof error.body === "object" && "code" in error.body) {
    switch (error.body.code) {
      case "no_layers":
        return "Add a source on Sources before choosing files.";
      case "no_stls":
        return "No print files are available yet. Sync or upload files to the source in the Library, then retry.";
      case "would_wipe":
        return "The source has no print files. Your existing Plan has been kept.";
      case "production_active":
        return "This change affects a recorded or queued print. Your edits are kept, but could not be saved. Resolve the affected print in Checkoff or Production before retrying.";
      case "checkoff_remap_unsafe": {
        const rows = "unmappable" in error.body && Array.isArray(error.body.unmappable) ? error.body.unmappable : [];
        const filenames = rows.flatMap((row) => row && typeof row === "object" && "filename" in row && typeof row.filename === "string" ? [row.filename] : []);
        const affected = [...new Set(filenames)].join(", ");
        return `${affected ? `${affected}: this` : "This"} change affects a recorded or queued print. Your edits are kept, but could not be saved. Restore the affected file in Plan, or resolve its print in Checkoff or Production, then retry.`;
      }
      case "merge_conflicts":
        return "Your edits overlap with another Plan change. They have been kept. Resolve the overlapping files before retrying.";
      case "base_changed":
      case "inputs_changed":
      case "draft_changed":
        return "The Plan or its source files changed in another window. Reload the latest Plan before saving.";
    }
  }
  return error instanceof Error ? error.message : String(error);
}

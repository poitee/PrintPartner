export type ImportRulesSaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export const IMPORT_RULES_AUTOSAVE_MS = 200;
export const IMPORT_RULES_SAVED_CLEAR_MS = 3000;

function normalizeRuleForCompare(rule: string): string {
  const r = rule.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!r) return r;
  if (r.endsWith("/")) return r;
  if (r.toLowerCase().endsWith(".stl")) return r;
  return `${r}/`;
}

export function rulesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].map(normalizeRuleForCompare).sort();
  const sortedB = [...b].map(normalizeRuleForCompare).sort();
  return sortedA.every((rule, i) => rule === sortedB[i]);
}

export function importRulesSaveStatusLabel(status: ImportRulesSaveStatus): string | null {
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

export function shouldShowImportRulesRetry(status: ImportRulesSaveStatus): boolean {
  return status === "error";
}

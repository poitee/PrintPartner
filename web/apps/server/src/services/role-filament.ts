/** Canonical STL export role id used for grouping and bulk filament updates. */
export function normalizePartRole(role: string | null | undefined): string {
  const trimmed = (role ?? "primary").trim().toLowerCase();
  return trimmed || "primary";
}

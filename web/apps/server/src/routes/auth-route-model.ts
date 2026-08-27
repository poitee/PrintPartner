export function normalizeEmailInput(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmailInput(email: string): boolean {
  return Boolean(email && email.includes("@"));
}

export function defaultDisplayName(input: {
  displayName: unknown;
  email: string;
}): string {
  const explicit = typeof input.displayName === "string" ? input.displayName.trim() : "";
  return explicit || input.email.split("@")[0] || "User";
}

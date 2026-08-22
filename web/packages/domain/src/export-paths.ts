export function safePlanSlug(profileName: string): string {
  const slug = (profileName || "export")
    .replace(/\s+/g, "_")
    .replace(/[^\w\-.]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return !slug || slug === "." || slug === ".." ? "export" : slug;
}

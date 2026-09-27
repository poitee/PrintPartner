
import type { ManifestSelections } from "@print-partner/contracts";
import { formatManifestSelection } from "../services/manifest-selections.js";
const MAX_CATALOG_CHARS = 6000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n…[truncated]`;
}

function summarizeKitCatalog(catalog: Record<string, unknown>): string {
  const bases = (catalog.bases ?? {}) as Record<
    string,
    { label?: string; source_name?: string; compatible_addons?: string[]; default_addons?: string[] }
  >;
  const categories = (catalog.addon_categories ?? {}) as Record<
    string,
    { rule?: string; sources?: Array<{ name?: string; label?: string }> }
  >;
  const presets = (catalog.stack_presets ?? {}) as Record<
    string,
    { label?: string; base?: string; addon_sources?: string[]; default_selections?: ManifestSelections }
  >;

  const baseLines = Object.entries(bases).map(([id, b]) => {
    const addons = (b.compatible_addons ?? []).join(", ") || "—";
    return `- ${id}: ${b.label ?? id} (source: ${b.source_name ?? "?"}; addons: ${addons})`;
  });

  const catLines = Object.entries(categories).map(([id, c]) => {
    const names = (c.sources ?? []).map((s) => s.name).filter(Boolean).join(", ");
    return `- ${id}${c.rule ? ` [${c.rule}]` : ""}: ${names || "—"}`;
  });

  const presetLines = Object.entries(presets).map(([id, p]) => {
    const sels = p.default_selections
      ? Object.entries(p.default_selections)
          .map(([key, selection]) =>
            `${key}=${formatManifestSelection(selection)}`,
          )
          .join(", ")
      : "";
    return `- ${id}: base=${p.base ?? "?"}; addons=[${(p.addon_sources ?? []).join(", ")}]${sels ? `; selections={${sels}}` : ""}`;
  });

  return truncate(
    [
      "## Kit catalog (summarized)",
      "### Bases",
      ...baseLines,
      "### Addon categories",
      ...catLines,
      "### Stack presets",
      ...presetLines,
    ].join("\n"),
    MAX_CATALOG_CHARS,
  );
}

export {   summarizeKitCatalog };

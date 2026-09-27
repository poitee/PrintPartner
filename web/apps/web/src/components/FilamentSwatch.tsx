import type { CatalogColor, FilamentCatalog } from "../api/endpoints/filaments";

export function allCatalogColors(catalog: FilamentCatalog | null): CatalogColor[] {
  if (!catalog) return [];
  return [
    ...catalog.colors,
    ...catalog.custom_colors,
    ...(catalog.spoolman_colors ?? []),
  ];
}

export function catalogColorGroups(catalog: FilamentCatalog | null): Array<{
  label: string;
  colors: CatalogColor[];
}> {
  if (!catalog) return [];
  const groups: Array<{ label: string; colors: CatalogColor[] }> = [];
  if (catalog.colors.length) groups.push({ label: "Catalog", colors: catalog.colors });
  if (catalog.custom_colors.length) {
    groups.push({ label: "Custom", colors: catalog.custom_colors });
  }
  if (catalog.spoolman_colors?.length) {
    groups.push({ label: "Spoolman", colors: catalog.spoolman_colors });
  }
  return groups;
}

import type { CatalogColor, FilamentCatalog } from "../api/engine";

type Props = {
  hex?: string | null;
  label?: string;
  className?: string;
};

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

export default function FilamentSwatch({ hex, label, className }: Props) {
  const style = hex ? { backgroundColor: hex } : undefined;
  return (
    <span
      className={`filament-swatch inline-block h-4 w-4 shrink-0 rounded border border-border ${className ?? ""}`}
      style={style}
      title={label ?? hex ?? "No filament color"}
      aria-hidden={!label}
    />
  );
}

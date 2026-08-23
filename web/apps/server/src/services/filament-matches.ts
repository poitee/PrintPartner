import type { CatalogColor } from "./filament-catalog.js";

export type RankedFilamentMatch = CatalogColor & Readonly<{
  exact_name: boolean;
  name_match: boolean;
  brand_match: boolean;
  color_distance: number | null;
}>;

type MatchQuery = Readonly<{ name: string; brand?: string; colorHex?: string }>;

function rgb(hex: string): readonly [number, number, number] | null {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return null;
  return [Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16), Number.parseInt(match[3]!, 16)];
}

function colorDistance(left: string, right: string): number | null {
  const a = rgb(left);
  const b = rgb(right);
  if (!a || !b) return null;
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2,
  );
}

export function rankFilamentMatches(
  inventory: readonly CatalogColor[],
  query: MatchQuery,
): RankedFilamentMatch[] {
  const name = query.name.trim().toLowerCase();
  const brand = query.brand?.trim().toLowerCase() ?? "";
  const hasColor = rgb(query.colorHex ?? "") != null;
  return inventory
    .map((color): RankedFilamentMatch => {
      const displayName = color.display_name.toLowerCase();
      return {
        ...color,
        exact_name: displayName === name,
        name_match: Boolean(name) && displayName.includes(name),
        brand_match: Boolean(brand) && color.product_line.toLowerCase().includes(brand),
        color_distance: hasColor ? colorDistance(color.hex, query.colorHex ?? "") : null,
      };
    })
    .filter((match) => match.exact_name || match.name_match || match.brand_match || hasColor)
    .sort((left, right) =>
      Number(right.exact_name && right.brand_match) - Number(left.exact_name && left.brand_match) ||
      Number(right.exact_name) - Number(left.exact_name) ||
      Number(right.brand_match) - Number(left.brand_match) ||
      Number(right.name_match) - Number(left.name_match) ||
      (left.color_distance ?? Number.POSITIVE_INFINITY) -
        (right.color_distance ?? Number.POSITIVE_INFINITY) ||
      left.display_name.localeCompare(right.display_name),
    );
}

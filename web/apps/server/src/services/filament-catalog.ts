import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CatalogColor = {
  id: string;
  display_name: string;
  product_line: string;
  hex: string;
  combo_label: string;
  swatch_url: string;
};

export type FilamentCatalogPayload = {
  synced_at: string;
  source: string;
  status: string;
  colors: CatalogColor[];
  custom_colors: CatalogColor[];
  spoolman_colors?: CatalogColor[];
  default_spoolman_integration_id?: string | null;
  spoolman_status?: "ok" | "empty" | "error" | "disabled" | "not_found";
  spoolman_error?: string | null;
};

function catalogColorFromRaw(c: Record<string, unknown>): CatalogColor {
  const id = String(c.id ?? "");
  const display = String(c.display_name ?? id);
  const line = String(c.product_line ?? "");
  const hex = String(c.hex ?? "#888888");
  return {
    id,
    display_name: display,
    product_line: line,
    hex,
    combo_label: line ? `${line} · ${display}` : display,
    swatch_url: String(c.swatch_url ?? ""),
  };
}

let cached: FilamentCatalogPayload | null = null;

export function loadFilamentCatalog(): FilamentCatalogPayload {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../data/ambrosia_fallback.json"),
    join(here, "../../data/ambrosia_fallback.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        synced_at?: string;
        source?: string;
        colors?: Array<Record<string, unknown>>;
      };
      const colors = (raw.colors ?? []).map(catalogColorFromRaw);
      cached = {
        synced_at: raw.synced_at ?? new Date().toISOString(),
        source: raw.source ?? "bundled",
        status: "ok",
        colors,
        custom_colors: [],
      };
      return cached;
    } catch {
      break;
    }
  }
  cached = {
    synced_at: new Date().toISOString(),
    source: "minimal",
    status: "fallback",
    colors: [
      {
        id: "primary::gray",
        display_name: "Gray",
        product_line: "Default",
        hex: "#808080",
        combo_label: "Default · Gray",
        swatch_url: "",
      },
    ],
    custom_colors: [],
  };
  return cached;
}

export function getColorById(colorId: string): CatalogColor | null {
  const catalog = loadFilamentCatalog();
  return catalog.colors.find((c) => c.id === colorId) ?? null;
}

export function resolvePartFilamentHex(part: {
  filamentColorId: string | null;
  filamentCustomHex: string | null;
}): string | null {
  if (part.filamentCustomHex) return part.filamentCustomHex;
  if (!part.filamentColorId) return null;
  return getColorById(part.filamentColorId)?.hex ?? null;
}

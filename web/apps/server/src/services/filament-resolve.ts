import type { AppRepository } from "../db/repository.js";
import { getIntegrationConfig } from "../integrations/store.js";
import {
  buildSpoolmanFilamentId,
  formatSpoolmanFilamentLabel,
  listSpoolmanFilaments,
  listSpoolmanSpools,
  normalizeSpoolmanHex,
  parseSpoolmanFilamentId,
  spoolSummariesForFilament,
  spoolSummariesForPart,
  type SpoolSummary,
  type SpoolmanFilament,
  type SpoolmanSpool,
} from "../integrations/spoolman-client.js";
import { getColorById, type CatalogColor } from "./filament-catalog.js";
import { listCustomFilaments } from "./custom-filaments.js";

export type FilamentDisplay = {
  combo_label: string;
  hex: string | null;
  display_name: string;
};

export type FilamentResolveContext = {
  resolve(colorId: string | null | undefined): FilamentDisplay | null;
  spoolSummaries(colorId: string | null | undefined): SpoolSummary[];
  spoolSummariesForPart(
    colorId: string | null | undefined,
    spoolRef: string | null | undefined,
  ): SpoolSummary[];
};

type ResolveDeps = {
  repo: AppRepository;
  dataDir: string;
};

function fromCatalogColor(color: CatalogColor): FilamentDisplay {
  return {
    combo_label: color.combo_label,
    hex: color.hex,
    display_name: color.display_name,
  };
}

function fromCustomFilament(f: {
  combo_label: string;
  hex: string;
  display_name: string;
}): FilamentDisplay {
  return {
    combo_label: f.combo_label,
    hex: f.hex,
    display_name: f.display_name,
  };
}

function fromSpoolmanFilament(filament: SpoolmanFilament): FilamentDisplay {
  return {
    combo_label: formatSpoolmanFilamentLabel(filament),
    hex: normalizeSpoolmanHex(filament.color_hex),
    display_name: filament.name?.trim() || `Filament #${filament.id}`,
  };
}

/** Sync resolution: built-in catalog and custom filaments only. */
export function resolveFilamentDisplaySync(
  deps: ResolveDeps,
  colorId: string | null | undefined,
): FilamentDisplay | null {
  const fid = (colorId ?? "").trim();
  if (!fid) return null;

  const catalog = getColorById(fid);
  if (catalog) return fromCatalogColor(catalog);

  const custom = listCustomFilaments(deps.dataDir).find((c) => c.id === fid);
  if (custom) return fromCustomFilament(custom);

  return null;
}

/** Full async resolution including Spoolman (uses short TTL cache in client). */
export async function resolveFilamentDisplay(
  deps: ResolveDeps,
  colorId: string | null | undefined,
): Promise<FilamentDisplay | null> {
  const sync = resolveFilamentDisplaySync(deps, colorId);
  if (sync) return sync;

  const parsed = parseSpoolmanFilamentId((colorId ?? "").trim());
  if (!parsed) return null;

  const integration = getIntegrationConfig(deps.repo, parsed.integrationId);
  if (!integration || integration.type !== "spoolman") return null;
  if (integration.config.enabled === false) return null;

  try {
    const filaments = await listSpoolmanFilaments(integration.config);
    const filament = filaments.find((f) => f.id === parsed.filamentId);
    if (!filament) return null;
    return fromSpoolmanFilament(filament);
  } catch {
    return null;
  }
}

export async function buildFilamentResolveContext(deps: ResolveDeps): Promise<FilamentResolveContext> {
  const spoolmanFilamentByKey = new Map<string, SpoolmanFilament>();
  const spoolsByIntegration = new Map<string, SpoolmanSpool[]>();

  const defaultId = deps.repo.getSetting("default_spoolman_integration_id")?.trim();
  if (defaultId) {
    const integration = getIntegrationConfig(deps.repo, defaultId);
    if (integration?.type === "spoolman" && integration.config.enabled !== false) {
      try {
        const [filaments, spools] = await Promise.all([
          listSpoolmanFilaments(integration.config),
          listSpoolmanSpools(integration.config),
        ]);
        spoolsByIntegration.set(integration.id, spools);
        for (const f of filaments) {
          spoolmanFilamentByKey.set(
            buildSpoolmanFilamentId(integration.id, f.id),
            f,
          );
        }
      } catch {
        /* Spoolman unavailable — catalog/custom still work */
      }
    }
  }

  const integrationIds = new Set<string>();
  for (const key of spoolmanFilamentByKey.keys()) {
    const parsed = parseSpoolmanFilamentId(key);
    if (parsed) integrationIds.add(parsed.integrationId);
  }

  return {
    resolve(colorId) {
      const sync = resolveFilamentDisplaySync(deps, colorId);
      if (sync) return sync;
      const fid = (colorId ?? "").trim();
      const filament = spoolmanFilamentByKey.get(fid);
      if (filament) return fromSpoolmanFilament(filament);
      return null;
    },

    spoolSummaries(colorId) {
      const parsed = parseSpoolmanFilamentId((colorId ?? "").trim());
      if (!parsed) return [];
      const spools = spoolsByIntegration.get(parsed.integrationId);
      if (!spools) return [];
      return spoolSummariesForFilament(spools, parsed.filamentId);
    },

    spoolSummariesForPart(colorId, spoolRef) {
      const parsed = parseSpoolmanFilamentId((colorId ?? "").trim());
      if (!parsed) return [];
      const spools = spoolsByIntegration.get(parsed.integrationId);
      if (!spools) return [];
      return spoolSummariesForPart(spools, parsed.filamentId, spoolRef);
    },
  };
}

/** Preload Spoolman filaments referenced by color IDs (any integration). */
export async function preloadSpoolmanForColorIds(
  deps: ResolveDeps,
  colorIds: Iterable<string | null | undefined>,
): Promise<FilamentResolveContext> {
  const byIntegration = new Map<string, Set<number>>();
  for (const raw of colorIds) {
    const parsed = parseSpoolmanFilamentId((raw ?? "").trim());
    if (!parsed) continue;
    let ids = byIntegration.get(parsed.integrationId);
    if (!ids) {
      ids = new Set();
      byIntegration.set(parsed.integrationId, ids);
    }
    ids.add(parsed.filamentId);
  }

  const spoolmanFilamentByKey = new Map<string, SpoolmanFilament>();
  const spoolsByIntegration = new Map<string, SpoolmanSpool[]>();

  await Promise.all(
    [...byIntegration.entries()].map(async ([integrationId]) => {
      const integration = getIntegrationConfig(deps.repo, integrationId);
      if (!integration || integration.type !== "spoolman") return;
      if (integration.config.enabled === false) return;
      try {
        const [filaments, spools] = await Promise.all([
          listSpoolmanFilaments(integration.config),
          listSpoolmanSpools(integration.config),
        ]);
        spoolsByIntegration.set(integration.id, spools);
        for (const f of filaments) {
          spoolmanFilamentByKey.set(
            buildSpoolmanFilamentId(integration.id, f.id),
            f,
          );
        }
      } catch {
        /* ignore */
      }
    }),
  );

  const base = await buildFilamentResolveContext(deps);
  const mergedFilaments = new Map<string, SpoolmanFilament>();
  for (const [k, v] of spoolmanFilamentByKey) mergedFilaments.set(k, v);

  return {
    resolve(colorId) {
      const sync = resolveFilamentDisplaySync(deps, colorId);
      if (sync) return sync;
      const fid = (colorId ?? "").trim();
      const filament = mergedFilaments.get(fid);
      if (filament) return fromSpoolmanFilament(filament);
      return base.resolve(colorId);
    },
    spoolSummaries(colorId) {
      const parsed = parseSpoolmanFilamentId((colorId ?? "").trim());
      if (!parsed) return [];
      const spools = spoolsByIntegration.get(parsed.integrationId);
      if (spools) return spoolSummariesForFilament(spools, parsed.filamentId);
      return base.spoolSummaries(colorId);
    },
    spoolSummariesForPart(colorId, spoolRef) {
      const parsed = parseSpoolmanFilamentId((colorId ?? "").trim());
      if (!parsed) return [];
      const spools = spoolsByIntegration.get(parsed.integrationId);
      if (spools) return spoolSummariesForPart(spools, parsed.filamentId, spoolRef);
      return base.spoolSummariesForPart(colorId, spoolRef);
    },
  };
}

export async function enrichRoleFilamentRows<
  T extends {
    filament_color_id: string | null;
    filament_custom_hex?: string | null;
    filament_display: string;
    filament_hex: string | null;
  },
>(rows: T[], deps: ResolveDeps): Promise<void> {
  const ctx = await preloadSpoolmanForColorIds(
    deps,
    rows.map((r) => r.filament_color_id),
  );
  for (const row of rows) {
    if (row.filament_color_id) {
      const resolved = ctx.resolve(row.filament_color_id);
      if (resolved) {
        row.filament_display = resolved.combo_label;
        row.filament_hex = resolved.hex;
        continue;
      }
      if (!row.filament_display) row.filament_display = row.filament_color_id;
    }
    if (row.filament_custom_hex) {
      row.filament_hex = row.filament_custom_hex;
      if (!row.filament_display) row.filament_display = "Custom color";
    }
  }
}

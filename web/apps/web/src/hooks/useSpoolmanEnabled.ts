import { useCallback, useEffect, useState } from "react";
import { fetchFilamentCatalog, type FilamentCatalog } from "../api/engine";

export type SpoolmanCatalogState = {
  catalog: FilamentCatalog | null;
  integrationId: string | null;
  /** Filament catalog from Spoolman loaded successfully (Build color picker). */
  enabled: boolean;
  /** Default Spoolman integration is set and usable for spool inventory (Review column). */
  configured: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
};

/** True when a default Spoolman integration is selected and reachable for the picker. */
export function isSpoolmanIntegrationActive(catalog: FilamentCatalog | null | undefined): boolean {
  const integrationId = catalog?.default_spoolman_integration_id?.trim();
  if (!integrationId) return false;
  return catalog?.spoolman_status === "ok";
}

/** True when Spoolman is set as default and not disabled — spool lists may still work if filaments failed. */
export function isSpoolmanIntegrationConfigured(
  catalog: FilamentCatalog | null | undefined,
): boolean {
  const integrationId = catalog?.default_spoolman_integration_id?.trim();
  if (!integrationId) return false;
  const status = catalog?.spoolman_status;
  return status !== "disabled" && status !== "not_found";
}

export function useSpoolmanEnabled(): SpoolmanCatalogState {
  const [catalog, setCatalog] = useState<FilamentCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCatalog(await fetchFilamentCatalog());
    } catch {
      setCatalog(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const integrationId = catalog?.default_spoolman_integration_id?.trim() ?? null;
  const enabled = isSpoolmanIntegrationActive(catalog);
  const configured = isSpoolmanIntegrationConfigured(catalog);

  return { catalog, integrationId, enabled, configured, loading, refresh };
}

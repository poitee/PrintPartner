import type { StatusExecution, StatusPermit } from "./status-execution.js";
import type {
  DeviceSummary,
  IntegrationConfig,
  IntegrationSummary,
  IntegrationTestResult,
  IntegrationType,
  PrinterCamera,
  PrinterHostStatus,
  PrinterStorageListing,
  PrinterUploadResult,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

/** In-memory bytes or a path on disk (streamed by adapters). */
export type PrinterUploadSource = Uint8Array | { path: string };

/** Optional host capability for browsing and opening already-sliced files. */
export type PrinterFileAccess = {
  /**
   * List one directory. `path` is relative to the host's print-file root; the
   * empty string is the root itself. One directory at a time, because that is
   * what the providers serve and what an operator browses.
   */
  browse(config: IntegrationConfig, path: string): Promise<PrinterStorageListing>;
  open(config: IntegrationConfig, path: string): Promise<Response>;
};

/** Optional host capability for credential-safe camera views. */
export type PrinterCameraAccess = {
  list(config: IntegrationConfig): Promise<PrinterCamera[]>;
  open(config: IntegrationConfig, cameraId: string): Promise<Response>;
};

export type IntegrationAdapter = {
  type: IntegrationType;
  getObjectList?(config: IntegrationConfig): Promise<string[]>;
  files?: PrinterFileAccess;
  cameras?: PrinterCameraAccess;
  uploadFile?(
    config: IntegrationConfig,
    source: PrinterUploadSource,
    filename: string,
    options?: { start?: boolean },
  ): Promise<PrinterUploadResult>;
  /**
   * Return the amount of filament consumed by the last/current print job, in mm.
   * Returns null when not supported or the value is unavailable.
   */
  getFilamentUsed?(config: IntegrationConfig): Promise<number | null>;
} & (
  | {
      getStatus(config: IntegrationConfig, permit: StatusPermit): Promise<PrinterHostStatus>;
      testConnection(config: IntegrationConfig, permit: StatusPermit): Promise<IntegrationTestResult>;
      listDevices?(config: IntegrationConfig, permit: StatusPermit): Promise<DeviceSummary[]>;
    }
  | {
      getStatus?: undefined;
      testConnection(config: IntegrationConfig): Promise<IntegrationTestResult>;
      listDevices?(config: IntegrationConfig): Promise<DeviceSummary[]>;
    }
);

export interface IntegrationPort {
  list(): IntegrationSummary[];
  get(id: string): IntegrationSummary | null;
  create(input: {
    type: IntegrationType;
    name: string;
    config: IntegrationConfig;
  }): IntegrationSummary;
  update(
    id: string,
    patch: { name?: string; config?: IntegrationConfig },
  ): IntegrationSummary | null;
  delete(id: string): boolean;
  test(id: string): Promise<IntegrationTestResult>;
  listDevices(id: string): Promise<DeviceSummary[]>;
  getStatus(id: string): Promise<PrinterHostStatus>;
}

type IntegrationStoreDeps = {
  statusExecution: StatusExecution;
  repo: AppRepository;
  getAdapter(type: IntegrationType): IntegrationAdapter | undefined;
};

const SETTINGS_KEY = "integrations";

const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "search_api_key",
  "token",
  "password",
  "secret",
  "access_token",
  "access_code",
  "accesscode",
]);

const REDACTED = "****";

function mergeIntegrationConfig(
  existing: IntegrationConfig,
  patch: IntegrationConfig,
): IntegrationConfig {
  const out = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (SECRET_KEYS.has(key.toLowerCase()) && value === REDACTED) continue;
    out[key] = value;
  }
  return out;
}

function redactConfig(config: IntegrationConfig): IntegrationConfig {
  const out: IntegrationConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEYS.has(key.toLowerCase()) && value != null && value !== "") {
      out[key] = "****";
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Every stored element, including corrupt ones, so writes never erase data they cannot read. */
function loadStored(repo: AppRepository): unknown[] {
  const raw = repo.getSetting(SETTINGS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isIntegration(x: unknown): x is IntegrationSummary {
  return typeof x === "object" && x !== null && typeof (x as { id?: unknown }).id === "string";
}

/** Readable integrations; a corrupt element (e.g. null) is skipped instead of crashing every lookup. */
function loadRaw(repo: AppRepository): IntegrationSummary[] {
  return loadStored(repo).filter(isIntegration);
}

function saveRaw(repo: AppRepository, items: unknown[]): void {
  repo.setSetting(SETTINGS_KEY, JSON.stringify(items));
}

/**
 * Read-side only. `saveRaw` is always fed from `loadStored`, never from these
 * projections, so the derived field cannot leak into stored settings.
 */
function withCapabilities(
  item: IntegrationSummary,
  deps: IntegrationStoreDeps,
): IntegrationSummary {
  const adapter = deps.getAdapter(item.type);
  return {
    ...item,
    config: redactConfig(item.config),
    capabilities: {
      files: adapter?.files !== undefined,
      cameras: adapter?.cameras !== undefined,
      status: adapter?.getStatus !== undefined,
    },
  };
}

export function createIntegrationPort(deps: IntegrationStoreDeps): IntegrationPort {
  const execution = deps.statusExecution;
  return {
    list(): IntegrationSummary[] {
      return loadRaw(deps.repo).map((item) => withCapabilities(item, deps));
    },

    get(id: string): IntegrationSummary | null {
      const item = loadRaw(deps.repo).find((x) => x.id === id);
      return item ? withCapabilities(item, deps) : null;
    },

    create(input): IntegrationSummary {
      const now = new Date().toISOString();
      const item: IntegrationSummary = {
        id: crypto.randomUUID(),
        type: input.type,
        name: input.name,
        config: input.config,
        created_at: now,
        updated_at: now,
      };
      const items = loadStored(deps.repo);
      items.push(item);
      saveRaw(deps.repo, items);
      return { ...item, config: redactConfig(item.config) };
    },

    update(id, patch): IntegrationSummary | null {
      const items = loadStored(deps.repo);
      const idx = items.findIndex((x) => isIntegration(x) && x.id === id);
      const existing = items[idx];
      if (!isIntegration(existing)) return null;
      const mergedConfig = patch.config
        ? mergeIntegrationConfig(existing.config, patch.config)
        : existing.config;
      const updated: IntegrationSummary = {
        ...existing,
        name: patch.name ?? existing.name,
        config: mergedConfig,
        updated_at: new Date().toISOString(),
      };
      items[idx] = updated;
      saveRaw(deps.repo, items);
      return { ...updated, config: redactConfig(updated.config) };
    },

    delete(id): boolean {
      const items = loadStored(deps.repo);
      const next = items.filter((x) => !isIntegration(x) || x.id !== id);
      if (next.length === items.length) return false;
      saveRaw(deps.repo, next);
      return true;
    },

    async test(id): Promise<IntegrationTestResult> {
      const items = loadRaw(deps.repo);
      const item = items.find((x) => x.id === id);
      if (!item) return { ok: false, message: "Integration not found" };
      const adapter = deps.getAdapter(item.type);
      if (!adapter) return { ok: false, message: `Unknown integration type: ${item.type}` };
      return execution.test(adapter, item.config);
    },

    async listDevices(id): Promise<DeviceSummary[]> {
      const items = loadRaw(deps.repo);
      const item = items.find((x) => x.id === id);
      if (!item) return [];
      const adapter = deps.getAdapter(item.type);
      if (!adapter?.listDevices) return [];
      return execution.devices(adapter, item.config);
    },

    async getStatus(id): Promise<PrinterHostStatus> {
      const items = loadRaw(deps.repo);
      const item = items.find((x) => x.id === id);
      if (!item) {
        return { state: "offline", message: "Integration not found" };
      }
      if (item.config.enabled === false) {
        return { state: "offline", message: "Integration disabled" };
      }
      const adapter = deps.getAdapter(item.type);
      if (!adapter?.getStatus) {
        return { state: "unknown", message: `Status not supported for ${item.type}` };
      }
      try {
        return await execution.probe(adapter, item.config);
      } catch (e) {
        return {
          state: "offline",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}

/** Internal: full config for adapter calls (not redacted). */
export function getIntegrationConfig(repo: AppRepository, id: string): IntegrationSummary | null {
  return loadRaw(repo).find((x) => x.id === id) ?? null;
}

/** Internal: unredacted integrations of a given type (newest first). */
export function listIntegrationsByType(
  repo: AppRepository,
  type: IntegrationType,
): IntegrationSummary[] {
  return loadRaw(repo)
    .filter((x) => x.type === type)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

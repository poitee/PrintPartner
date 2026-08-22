import type { IntegrationConfig } from "@print-partner/contracts";
import type { CatalogColor } from "../services/filament-catalog.js";
import { assertSafeOutboundUrl } from "../lib/outbound-url.js";

const REQUEST_TIMEOUT_MS = 8000;
const SPOOLMAN_FILAMENT_ID_RE = /^spoolman:([^:]+):filament:(\d+)$/;
const SPOOLMAN_SPOOL_ID_RE = /^spoolman:([^:]+):spool:(\d+)$/;

export type SpoolmanVendorRef =
  | string
  | null
  | undefined
  | { id?: number; name?: string | null };

export type SpoolmanFilament = {
  id: number;
  name: string | null;
  vendor: string | null;
  material: string | null;
  color_hex: string | null;
};

export type SpoolmanSpool = {
  id: number;
  filament_id: number;
  remaining_weight: number | null;
  location?: string | null;
  filament?: SpoolmanFilament | null;
};

export type SpoolSummary = {
  remaining_g: number;
  spool_id: number;
};

export function buildSpoolmanFilamentId(
  integrationId: string,
  filamentId: number | string,
): string {
  return `spoolman:${integrationId}:filament:${filamentId}`;
}

export function parseSpoolmanFilamentId(
  colorId: string,
): { integrationId: string; filamentId: number } | null {
  const m = SPOOLMAN_FILAMENT_ID_RE.exec(colorId.trim());
  if (!m) return null;
  return { integrationId: m[1]!, filamentId: Number(m[2]) };
}

export function buildSpoolmanSpoolId(
  integrationId: string,
  spoolId: number | string,
): string {
  return `spoolman:${integrationId}:spool:${spoolId}`;
}

export function parseSpoolmanSpoolId(
  spoolRef: string,
): { integrationId: string; spoolId: number } | null {
  const m = SPOOLMAN_SPOOL_ID_RE.exec(spoolRef.trim());
  if (!m) return null;
  return { integrationId: m[1]!, spoolId: Number(m[2]) };
}

export function formatSpoolOptionLabel(spool: SpoolmanSpool): string {
  const grams = Math.round(spool.remaining_weight ?? 0);
  const location = (spool.location ?? "").trim();
  return location
    ? `#${spool.id} · ~${grams} g · ${location}`
    : `#${spool.id} · ~${grams} g`;
}

export function normalizeSpoolmanHex(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "#888888";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

export function normalizeSpoolmanVendor(vendor: SpoolmanVendorRef): string {
  if (vendor == null) return "";
  if (typeof vendor === "string") return vendor.trim();
  if (typeof vendor === "object") return String(vendor.name ?? "").trim();
  return "";
}

export function normalizeSpoolmanFilament(raw: Record<string, unknown>): SpoolmanFilament | null {
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    name: raw.name != null ? String(raw.name) : null,
    vendor: normalizeSpoolmanVendor(raw.vendor as SpoolmanVendorRef) || null,
    material: raw.material != null ? String(raw.material) : null,
    color_hex: raw.color_hex != null ? String(raw.color_hex) : null,
  };
}

export function parseSpoolmanFilamentList(body: unknown): SpoolmanFilament[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as { items?: unknown[]; results?: unknown[]; data?: unknown[] }).items ??
        (body as { results?: unknown[] }).results ??
        (body as { data?: unknown[] }).data ??
        [])
      : [];
  const out: SpoolmanFilament[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const filament = normalizeSpoolmanFilament(row as Record<string, unknown>);
    if (filament) out.push(filament);
  }
  return out;
}

export function formatSpoolmanFilamentLabel(f: SpoolmanFilament): string {
  const vendor = (f.vendor ?? "").trim();
  const material = (f.material ?? "").trim();
  const name = (f.name ?? "").trim() || `Filament ${f.id}`;
  const prefix = [vendor, material].filter(Boolean).join(" ");
  return prefix ? `${prefix} · ${name}` : name;
}

export function spoolmanFilamentToCatalogColor(
  integrationId: string,
  f: SpoolmanFilament,
): CatalogColor {
  const vendor = (f.vendor ?? "").trim();
  const material = (f.material ?? "").trim();
  const name = (f.name ?? "").trim() || `Filament ${f.id}`;
  const product_line = [vendor, material].filter(Boolean).join(" ") || "Spoolman";
  const hex = normalizeSpoolmanHex(f.color_hex);
  return {
    id: buildSpoolmanFilamentId(integrationId, f.id),
    display_name: name,
    product_line,
    hex,
    combo_label: formatSpoolmanFilamentLabel(f),
    swatch_url: "",
  };
}

export function spoolSummariesForFilament(
  spools: SpoolmanSpool[],
  filamentId: number,
): SpoolSummary[] {
  return spools
    .filter((s) => s.filament_id === filamentId)
    .map((s) => ({
      spool_id: s.id,
      remaining_g: s.remaining_weight ?? 0,
    }))
    .filter((s) => s.remaining_g > 0);
}

/** When a spool is selected, show only that spool; otherwise aggregate all in-stock spools. */
export function spoolSummariesForPart(
  spools: SpoolmanSpool[],
  filamentId: number,
  selectedSpoolRef: string | null | undefined,
): SpoolSummary[] {
  const selected = parseSpoolmanSpoolId((selectedSpoolRef ?? "").trim());
  if (selected) {
    const spool = spools.find((s) => s.id === selected.spoolId && s.filament_id === filamentId);
    if (!spool) return [];
    const remaining_g = spool.remaining_weight ?? 0;
    if (remaining_g <= 0) return [];
    return [{ spool_id: spool.id, remaining_g }];
  }
  return spoolSummariesForFilament(spools, filamentId);
}

export function formatSpoolSummaryBadge(entries: SpoolSummary[]): string {
  if (!entries.length) return "";
  if (entries.length === 1) {
    const e = entries[0]!;
    return `~${Math.round(e.remaining_g)} g on spool #${e.spool_id}`;
  }
  const total = entries.reduce((sum, e) => sum + e.remaining_g, 0);
  const ids = entries.map((e) => `#${e.spool_id}`).join(", ");
  return `${entries.length} spools · ~${Math.round(total)} g (${ids})`;
}

export function normalizeSpoolmanBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith("/api/v1")) {
    url = url.slice(0, -"/api/v1".length).replace(/\/+$/, "");
  }
  return url || null;
}

function apiRoot(baseUrl: string): string {
  return `${baseUrl}/api/v1`;
}

function authHeaders(config: IntegrationConfig): Record<string, string> {
  const key = config.api_key ?? config.apiKey;
  if (typeof key === "string" && key.trim()) {
    return { Authorization: `Bearer ${key.trim()}` };
  }
  return {};
}

async function spoolmanFetch(
  baseUrl: string,
  config: IntegrationConfig,
  path: string,
): Promise<Response> {
  const url = `${apiRoot(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
  // Self-host users point Spoolman at LAN/private IPs; only metadata endpoints stay blocked.
  await assertSafeOutboundUrl(url, { allowPrivate: true });
  return fetch(url, {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function testSpoolmanConnection(
  config: IntegrationConfig,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const baseUrl = normalizeSpoolmanBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) {
    return { ok: false, message: "base_url is required" };
  }
  const paths = ["/info", "/health"];
  let lastError = "Spoolman did not respond";
  for (const path of paths) {
    try {
      const res = await spoolmanFetch(baseUrl, config, path);
      if (res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { version?: string; status?: string };
          detail = body.version ? `v${body.version}` : body.status ? String(body.status) : "";
        } catch {
          /* ignore parse errors */
        }
        return {
          ok: true,
          message: detail ? `Connected (${detail})` : "Connected",
        };
      }
      lastError = `Spoolman returned HTTP ${res.status} on ${path}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, message: lastError };
}

export async function listSpoolmanFilaments(
  config: IntegrationConfig,
): Promise<SpoolmanFilament[]> {
  const baseUrl = normalizeSpoolmanBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) {
    throw new Error("Spoolman base_url is required");
  }
  let res: Response;
  try {
    res = await spoolmanFetch(baseUrl, config, "/filament");
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Spoolman filaments request failed: ${detail}`, { cause: e });
  }
  if (!res.ok) {
    throw new Error(`Spoolman filaments request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  return parseSpoolmanFilamentList(body);
}

export function normalizeSpoolmanSpool(raw: Record<string, unknown>): SpoolmanSpool | null {
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  let filamentId = Number(raw.filament_id);
  if (!Number.isFinite(filamentId)) {
    const filament = raw.filament;
    if (filament && typeof filament === "object") {
      filamentId = Number((filament as Record<string, unknown>).id);
    }
  }
  if (!Number.isFinite(filamentId)) return null;
  const archived = raw.archived;
  if (archived === true || archived === 1 || archived === "true") return null;
  return {
    id,
    filament_id: filamentId,
    remaining_weight:
      raw.remaining_weight != null && raw.remaining_weight !== ""
        ? Number(raw.remaining_weight)
        : null,
    location: raw.location != null ? String(raw.location) : null,
  };
}

export function parseSpoolmanSpoolList(body: unknown): SpoolmanSpool[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as { items?: unknown[]; results?: unknown[]; data?: unknown[] }).items ??
        (body as { results?: unknown[] }).results ??
        (body as { data?: unknown[] }).data ??
        [])
      : [];
  const out: SpoolmanSpool[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const spool = normalizeSpoolmanSpool(row as Record<string, unknown>);
    if (spool) out.push(spool);
  }
  return out;
}

export async function listSpoolmanSpools(config: IntegrationConfig): Promise<SpoolmanSpool[]> {
  const baseUrl = normalizeSpoolmanBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) return [];
  const res = await spoolmanFetch(baseUrl, config, "/spool");
  if (!res.ok) {
    throw new Error(`Spoolman spools request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  return parseSpoolmanSpoolList(body);
}

/**
 * Record filament consumption on a spool.
 * @param spoolId  Numeric Spoolman spool id
 * @param useLengthMm  Filament consumed in millimetres
 */
export async function useSpoolFilament(
  config: IntegrationConfig,
  spoolId: number,
  useLengthMm: number,
): Promise<void> {
  const baseUrl = normalizeSpoolmanBaseUrl(config.base_url ?? config.baseUrl);
  if (!baseUrl) throw new Error("Spoolman base_url is required");
  await assertSafeOutboundUrl(`${apiRoot(baseUrl)}/spool/${spoolId}/use`, { allowPrivate: true });
  const res = await fetch(`${apiRoot(baseUrl)}/spool/${spoolId}/use`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(config),
    },
    body: JSON.stringify({ use_length: useLengthMm }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spoolman use spool failed: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}

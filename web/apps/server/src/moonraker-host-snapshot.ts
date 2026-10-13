import { z } from "zod";
import { isRecord } from "./lib/guards.js";

const moonrakerRow = z.object({
  id: z.string().min(1).refine((id) => Buffer.byteLength(id, "utf8") <= 256),
  config: z.record(z.string(), z.unknown()).nullish(),
});

/** Matches Rust `MAX_CONFIG_BYTES`: a larger field is isolated to its own id. */
const MAX_CONFIG_BYTES = 4096;

function disabledHost(id: string) {
  return { id, base_url: "", api_key: null, enabled: false };
}

function configBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Private desktop projection; unrelated integrations never consume the host budget. */
export function moonrakerHostSnapshot(raw: string | undefined | null) {
  let items: unknown;
  try {
    items = raw ? JSON.parse(raw) : [];
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const hosts: Array<z.infer<typeof moonrakerRow>> = [];
  const rows: readonly unknown[] = items;
  for (const item of rows) {
    if (!isRecord(item) || item.type !== "moonraker") continue;
    const parsed = moonrakerRow.safeParse(item);
    if (!parsed.success) return null;
    hosts.push(parsed.data);
  }
  // Over the cap, send ids only: Rust then fails every Moonraker id closed instead of
  // routing a newly added host to Node.
  if (hosts.length > 128) {
    return hosts.map((item) => disabledHost(item.id));
  }
  return hosts.map((item) => {
    const config = item.config ?? {};
    const base = config.base_url ?? config.baseUrl;
    const key = config.api_key ?? config.apiKey;
    const baseUrl = typeof base === "string" ? base : "";
    const apiKey = typeof key === "string" ? key : null;
    // Project before serialization so one huge row cannot exceed the snapshot limit
    // and stop every healthy poller. Rust still knows the id and does not poll it.
    if (configBytes(baseUrl) > MAX_CONFIG_BYTES || (apiKey !== null && configBytes(apiKey) > MAX_CONFIG_BYTES)) {
      return disabledHost(item.id);
    }
    return { id: item.id, base_url: baseUrl, api_key: apiKey, enabled: config.enabled !== false };
  });
}

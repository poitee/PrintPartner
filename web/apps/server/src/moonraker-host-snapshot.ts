/** Private desktop projection; unrelated integrations never consume the host budget. */
export function moonrakerHostSnapshot(raw: string | undefined | null) {
  const items: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(items)) return null;
  const hosts = items.filter((item) => item?.type === "moonraker");
  // Over the cap, send ids only: Rust then fails every Moonraker id closed instead of
  // routing a newly added host to Node.
  if (hosts.length > 128) {
    return hosts.map((item) => ({ id: String(item.id), base_url: "", api_key: null, enabled: false }));
  }
  return hosts.map((item) => {
    const config = item.config ?? {};
    const base = config.base_url ?? config.baseUrl;
    const key = config.api_key ?? config.apiKey;
    return { id: String(item.id), base_url: typeof base === "string" ? base : "",
      api_key: typeof key === "string" ? key : null, enabled: config.enabled !== false };
  });
}

/** Private desktop projection; unrelated integrations never consume the host budget. */
export function moonrakerHostSnapshot(raw: string | undefined | null) {
  const items: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(items)) return null;
  const hosts = items.filter((item) => item?.type === "moonraker");
  if (hosts.length > 128) return null;
  return hosts.map((item) => {
    const config = item.config ?? {};
    const base = config.base_url ?? config.baseUrl;
    const key = config.api_key ?? config.apiKey;
    return { id: String(item.id), base_url: typeof base === "string" ? base : "",
      api_key: typeof key === "string" ? key : null, enabled: config.enabled !== false };
  });
}

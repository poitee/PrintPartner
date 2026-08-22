import { OutboundUrlError, safeOutboundFetch } from "../../lib/outbound-url.js";
import type { SearchHit, WebSearchOptions } from "./types.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export async function searchBrave(
  options: WebSearchOptions,
  apiKey: string,
  fetchFn: typeof safeOutboundFetch = safeOutboundFetch,
): Promise<{ hits: SearchHit[]; error?: string }> {
  const q = options.site ? `site:${options.site} ${options.query}` : options.query;
  const count = Math.min(Math.max(options.maxResults ?? 5, 1), 20);
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(q)}&count=${count}`;

  try {
    const res = await fetchFn(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": "PrintPartner-Search/1.0",
      },
    });
    if (!res.ok) {
      return { hits: [], error: `Brave Search HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const hits: SearchHit[] = (body.web?.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, count)
      .map((r) => ({
        title: String(r.title),
        url: String(r.url),
        snippet: String(r.description ?? "").slice(0, 500),
      }));
    return { hits };
  } catch (err) {
    const msg =
      err instanceof OutboundUrlError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { hits: [], error: `Brave Search failed: ${msg}` };
  }
}

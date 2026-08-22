import { OutboundUrlError, safeOutboundFetch } from "../../lib/outbound-url.js";
import type { SearchHit, WebSearchOptions } from "./types.js";

const EXA_ENDPOINT = "https://api.exa.ai/search";

export async function searchExa(
  options: WebSearchOptions,
  apiKey: string,
  fetchFn: typeof safeOutboundFetch = safeOutboundFetch,
): Promise<{ hits: SearchHit[]; error?: string }> {
  const q = options.site ? `site:${options.site} ${options.query}` : options.query;
  const numResults = Math.min(Math.max(options.maxResults ?? 5, 1), 20);

  try {
    const res = await fetchFn(EXA_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "PrintPartner-Search/1.0",
      },
      body: JSON.stringify({
        query: q,
        numResults,
        type: "auto",
        contents: { text: { maxCharacters: 500 } },
      }),
    });
    if (!res.ok) {
      return { hits: [], error: `Exa Search HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        snippet?: string;
      }>;
    };
    const hits: SearchHit[] = (body.results ?? [])
      .filter((r) => r.url && (r.title || r.url))
      .slice(0, numResults)
      .map((r) => ({
        title: String(r.title || r.url),
        url: String(r.url),
        snippet: String(r.text ?? r.snippet ?? "").slice(0, 500),
      }));
    return { hits };
  } catch (err) {
    const msg =
      err instanceof OutboundUrlError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { hits: [], error: `Exa Search failed: ${msg}` };
  }
}

export type FetchWithRetryOptions = {
  retries?: number;
  backoffMs?: number;
  init?: RequestInit;
  /** Retry on these HTTP statuses (default: all non-ok except excluded). */
  retryStatuses?: number[];
};

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff retries for transient mesh/preview failures.
 */
export async function fetchWithRetry(
  url: string | (() => string | Promise<string>),
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const retryStatuses = options.retryStatuses ?? [404, 502, 503, 504];

  let lastResponse: Response | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resolvedUrl = typeof url === "function" ? await url() : url;
      const response = await fetch(resolvedUrl, options.init);
      lastResponse = response;

      if (response.ok || !retryStatuses.includes(response.status) || attempt >= retries) {
        return response;
      }
    } catch (e) {
      lastError = e;
      if (attempt >= retries) break;
    }

    await sleep(backoffMs * (attempt + 1));
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("Fetch failed");
}

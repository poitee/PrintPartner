import { Octokit } from "@octokit/rest";
import { readBoundedResponseBody } from "../lib/bounded-response.js";

const MAX_GITHUB_API_RESPONSE_BYTES = 16 * 1024 * 1024;
export const GITHUB_API_REQUEST_TIMEOUT_MS = 120_000;

function boundedGithubFetch(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return async (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline])
      : deadline;
    const response = await fetchImpl(input, { ...init, signal });
    if (!response.body) return response;
    const body = await readBoundedResponseBody(response, MAX_GITHUB_API_RESPONSE_BYTES);
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.set("content-length", String(body.byteLength));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export function createGithubClient(
  token?: string | null,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): Octokit {
  return new Octokit({
    ...(token ? { auth: token } : {}),
    request: {
      fetch: boundedGithubFetch(
        options.fetchImpl ?? fetch,
        options.timeoutMs ?? GITHUB_API_REQUEST_TIMEOUT_MS,
      ),
    },
  });
}

const ASSISTANT_PROVIDER_TIMEOUT_MS = 5 * 60_000;

export function fetchAssistantProvider(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const deadline = AbortSignal.timeout(ASSISTANT_PROVIDER_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

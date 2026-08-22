const MAX_SNIPPET = 240;

/** Strip credential-like substrings before returning provider errors to clients. */
function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[a-zA-Z0-9_-]+\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|x-api-key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

/**
 * Build a user-facing provider failure message with HTTP status and a short body
 * snippet (no secrets). Prefer structured `error.message` / `message` when present.
 */
export function formatProviderHttpError(
  label: string,
  status: number,
  bodyText: string,
): string {
  const raw = bodyText.replace(/\s+/g, " ").trim();
  if (raw) {
    try {
      const body = JSON.parse(raw) as {
        error?: string | { message?: string; type?: string };
        message?: string;
      };
      const fromError =
        typeof body.error === "string"
          ? body.error
          : body.error && typeof body.error === "object"
            ? body.error.message
            : undefined;
      const msg = fromError ?? body.message;
      if (typeof msg === "string" && msg.trim()) {
        return `${label} HTTP ${status}: ${redactSecrets(msg.trim()).slice(0, MAX_SNIPPET)}`;
      }
    } catch {
      /* use raw snippet below */
    }
  }
  const snippet = redactSecrets(raw).slice(0, MAX_SNIPPET);
  return snippet ? `${label} HTTP ${status}: ${snippet}` : `${label} HTTP ${status}`;
}

export async function readProviderHttpError(label: string, res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return formatProviderHttpError(label, res.status, text);
}

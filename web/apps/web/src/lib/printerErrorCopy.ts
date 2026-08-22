/**
 * Quiet desk copy for printer auth/availability failures.
 * Never surface Engine `/api/...` paths in the Progress UI.
 */

/** Strip any `/api/...` path segment (v1, v2, unversioned, etc.). */
function stripApiPaths(raw: string): string {
  return raw
    .replace(/^Engine\s+\/api\/\S+\s+failed:\s*/i, "")
    .replace(/\/api\/[^\s,;)'"`]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s·\-–—:]+|[\s·\-–—:]+$/g, "")
    .trim();
}

export function isPrinterAuthUnavailable(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\b401\b/.test(message) || /unauthorized/i.test(message);
}

export function quietPrinterLoadError(message: string | null | undefined): {
  quiet: boolean;
  text: string;
} {
  const raw = message?.trim() ?? "";
  if (isPrinterAuthUnavailable(raw)) {
    return { quiet: true, text: "Printers unavailable" };
  }
  const cleaned = stripApiPaths(raw);
  if (!cleaned || cleaned === "401" || /\/api\//i.test(cleaned)) {
    return { quiet: true, text: "Printers unavailable" };
  }
  return { quiet: false, text: cleaned };
}

export function quietPrinterStatusMessage(
  message: string | null | undefined,
): string | null {
  if (!message?.trim()) return null;
  const { quiet, text } = quietPrinterLoadError(message);
  if (quiet) return "Printers unavailable";
  // Guarantee no Engine /api path leaks into UI titles or job lines.
  if (/\/api\//i.test(text)) return "Printers unavailable";
  return text;
}

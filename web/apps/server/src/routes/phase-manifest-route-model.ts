/**
 * Parse a source's pp-phases.json. Accepts a bare array or { phases: [...] }.
 * Every entry needs a name and a folders list. Order and dependency edges are
 * normalized so the client always receives the full shape.
 */
export function parsePhaseManifestText(text: string): Array<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const rawPhases = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { phases?: unknown }).phases)
      ? (parsed as { phases: unknown[] }).phases
      : null;
  if (!rawPhases || !rawPhases.length) return null;

  const phases: Array<Record<string, unknown>> = [];
  for (const [index, entry] of rawPhases.entries()) {
    if (!entry || typeof entry !== "object") return null;
    const phase = entry as Record<string, unknown>;
    if (typeof phase.name !== "string" || !phase.name.trim()) return null;
    if (!Array.isArray(phase.folders) || phase.folders.some((folder) => typeof folder !== "string")) {
      return null;
    }
    phases.push({
      ...phase,
      order: typeof phase.order === "number" ? phase.order : index,
      depends_on: Array.isArray(phase.depends_on)
        ? phase.depends_on.filter((dependency) => typeof dependency === "string")
        : [],
    });
  }
  return phases;
}

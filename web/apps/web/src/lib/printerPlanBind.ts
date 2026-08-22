/**
 * GRE-232: quiet Send / Printers farm plan bind chrome (no second picker).
 */

export function sendPlanBindCopy(planName: string | null | undefined): {
  line: string;
  canSend: boolean;
} {
  const name = planName?.trim();
  if (name) {
    return { line: `For ${name}.`, canSend: true };
  }
  return { line: "Pick a plan to bind this send.", canSend: false };
}

/** Quiet caption after a live job filename on Printers farm. */
export function liveJobPlanCaption(planName: string | null | undefined): string {
  const name = planName?.trim();
  return name ? name : "No plan.";
}

function normalizeFilename(name: string | undefined | null): string {
  if (!name?.trim()) return "";
  const base = name.trim().replace(/\\/g, "/");
  const slash = base.lastIndexOf("/");
  return (slash >= 0 ? base.slice(slash + 1) : base).toLowerCase();
}

export type LiveJobCheckoffLink = {
  printer_id: string;
  filename: string;
  remote_path?: string;
  profile_id: number;
  state: string;
};

/**
 * Resolve this-plan name for a live farm job from stored checkoff links.
 * Spine changes do not rebind — links carry immutable profile_id from send.
 * Prefer active (watching / awaiting_verify) matches so a reprint under another
 * plan does not pick a stale terminal link with the same filename.
 */
export function findPlanNameForLiveJob(opts: {
  printerId: string;
  filename: string | undefined | null;
  links: readonly LiveJobCheckoffLink[];
  planNameById: Map<number, string> | Readonly<Record<number, string>>;
}): string | null {
  const hostFile = normalizeFilename(opts.filename);
  if (!hostFile || !opts.printerId) return null;

  const nameOf = (id: number): string | null => {
    if (opts.planNameById instanceof Map) {
      return opts.planNameById.get(id)?.trim() || null;
    }
    return opts.planNameById[id]?.trim() || null;
  };

  const ACTIVE = new Set(["watching", "awaiting_verify"]);
  let fallbackName: string | null = null;

  for (const link of opts.links) {
    if (link.printer_id !== opts.printerId) continue;
    const match =
      normalizeFilename(link.filename) === hostFile ||
      normalizeFilename(link.remote_path) === hostFile;
    if (!match) continue;
    const name = nameOf(link.profile_id);
    if (!name) continue;
    if (ACTIVE.has(link.state)) return name;
    if (fallbackName == null) fallbackName = name;
  }
  return fallbackName;
}

/**
 * Prefer stored plan_id; unbound binds once to active spine; never steal a bound job.
 */
export function resolvePlanIdForPrinterFetch(
  storedPlanId: number | null | undefined,
  activeSpinePlanId: number | null | undefined,
): number | null {
  if (
    typeof storedPlanId === "number" &&
    Number.isInteger(storedPlanId) &&
    storedPlanId > 0
  ) {
    return storedPlanId;
  }
  if (
    typeof activeSpinePlanId === "number" &&
    Number.isInteger(activeSpinePlanId) &&
    activeSpinePlanId > 0
  ) {
    return activeSpinePlanId;
  }
  return null;
}

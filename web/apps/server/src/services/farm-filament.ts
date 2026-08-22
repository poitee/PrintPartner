/**
 * Farm filament + activity derivations shared by the get_farm_status /
 * get_print_stats assistant tools and the Discord morning digest.
 *
 * Everything here is pure: callers inject the already-fetched Spoolman spool
 * summaries and print_jobs rows, so the derivations are unit-testable without
 * a network or a live printer. The tools own the I/O; this module owns the
 * "does this printer need a filament swap" / "how idle is it" judgement calls
 * so both consumers answer identically.
 */

import type { PrinterHostStatus } from "@print-partner/contracts";
import type { PrinterMachine } from "@print-partner/domain";
import type { AppRepository } from "../db/repository.js";
import { getIntegrationConfig } from "../integrations/store.js";
import {
  listSpoolmanSpools,
  parseSpoolmanFilamentId,
  spoolSummariesForFilament,
  type SpoolSummary,
  type SpoolmanSpool,
} from "../integrations/spoolman-client.js";

/**
 * Resolves a filament colour id to the spools backing it.
 *
 * The `null` return is load-bearing: it means "we have no inventory record for
 * this filament" (not Spoolman-backed, or Spoolman unreachable), which the swap
 * logic reports as unknown. An empty array means the opposite — Spoolman knows
 * this filament and every spool of it is depleted, which IS a swap trigger.
 */
export type SpoolLookup = (colorId: string) => SpoolSummary[] | null;

/**
 * Below this many grams remaining on a slot's filament we advise a swap.
 * Roughly one large plate's worth on a 1kg spool workflow — enough warning to
 * change the spool before the overnight run stalls.
 */
export const LOW_FILAMENT_THRESHOLD_G = 150;

/** Host status strings that mean "the machine is waiting on a human + filament". */
const RUNOUT_PATTERN = /\b(runout|run out|run-out|filament\s*(out|empty|error|jam)|out of filament|load filament|insert filament|filament\s*sensor)\b/i;

export type SlotFilamentStatus = {
  slot: number;
  label: string;
  filament_color_id: string | null;
  /**
   * Grams left across the spools backing this slot's filament.
   * `null` means "not tracked" (no filament assigned, or the filament is not a
   * Spoolman-backed id) — deliberately distinct from `0`, which means Spoolman
   * knows about it and every spool is depleted.
   */
  remaining_g: number | null;
  spool_ids: number[];
  /** No filament assigned to this slot at all. */
  empty: boolean;
  /** Tracked, and at or below the low-filament threshold (includes 0). */
  low: boolean;
};

export type PrinterFilamentStatus = {
  slots: SlotFilamentStatus[];
  needs_filament_swap: boolean;
  filament_swap_reason: string | null;
  /** Sum over slots with a known remaining figure; null when none are tracked. */
  filament_remaining_g: number | null;
};

/** Grams remaining for one slot, given a spool lookup for its filament id. */
export function slotFilamentStatus(
  slot: { slot: number; filament_color_id: string | null; label: string },
  lookupSpools: SpoolLookup,
): SlotFilamentStatus {
  const colorId = (slot.filament_color_id ?? "").trim() || null;
  const label = (slot.label ?? "").trim();

  const unknown = (empty: boolean): SlotFilamentStatus => ({
    slot: slot.slot,
    label,
    filament_color_id: colorId,
    remaining_g: null,
    spool_ids: [],
    empty,
    low: false,
  });

  if (!colorId) return unknown(true);

  // Only Spoolman-backed filaments carry a remaining-weight figure. A catalog or
  // custom filament id is a colour choice, not an inventory record, so it stays
  // "unknown" rather than being reported as 0 g and triggering a false swap alert.
  let summaries: SpoolSummary[] | null;
  try {
    summaries = lookupSpools(colorId);
  } catch {
    // Spoolman unreachable mid-call — degrade to "unknown", never throw out of
    // a status tool.
    return unknown(false);
  }
  if (summaries == null) return unknown(false);

  const remaining = summaries.reduce((sum, s) => sum + (s.remaining_g ?? 0), 0);
  return {
    slot: slot.slot,
    label,
    filament_color_id: colorId,
    remaining_g: Math.round(remaining),
    spool_ids: summaries.map((s) => s.spool_id),
    empty: false,
    low: remaining <= LOW_FILAMENT_THRESHOLD_G,
  };
}

/**
 * Does the live host status itself say the printer is out of filament?
 * Moonraker/PrusaLink surface this as a paused state plus a message; treat any
 * runout-ish message as a swap signal regardless of state, since a paused
 * printer with a runout message is exactly the morning-digest case.
 */
export function hostReportsFilamentRunout(
  status: Pick<PrinterHostStatus, "state" | "message"> | null | undefined,
): boolean {
  if (!status) return false;
  const message = (status.message ?? "").trim();
  if (message && RUNOUT_PATTERN.test(message)) return true;
  return false;
}

/**
 * Combine slot inventory with the live host status into a single swap verdict.
 * Precedence: an explicit host runout beats inventory, an empty slot beats a
 * low slot, and a low slot beats nothing.
 */
export function printerFilamentStatus(
  machine: Pick<PrinterMachine, "loaded_filaments">,
  lookupSpools: SpoolLookup,
  hostStatus?: Pick<PrinterHostStatus, "state" | "message"> | null,
): PrinterFilamentStatus {
  const slots = (machine.loaded_filaments ?? []).map((lf) => slotFilamentStatus(lf, lookupSpools));

  const trackedSlots = slots.filter((s) => s.remaining_g != null);
  const filamentRemainingG = trackedSlots.length
    ? trackedSlots.reduce((sum, s) => sum + (s.remaining_g ?? 0), 0)
    : null;

  if (hostReportsFilamentRunout(hostStatus)) {
    return {
      slots,
      needs_filament_swap: true,
      filament_swap_reason: `printer reports filament runout${
        hostStatus?.message ? `: ${hostStatus.message.trim()}` : ""
      }`,
      filament_remaining_g: filamentRemainingG,
    };
  }

  const emptySlots = slots.filter((s) => s.empty);
  if (emptySlots.length) {
    return {
      slots,
      needs_filament_swap: true,
      filament_swap_reason: `no filament loaded in slot ${emptySlots
        .map((s) => s.slot)
        .join(", ")}`,
      filament_remaining_g: filamentRemainingG,
    };
  }

  const lowSlots = slots.filter((s) => s.low);
  if (lowSlots.length) {
    return {
      slots,
      needs_filament_swap: true,
      filament_swap_reason: lowSlots
        .map((s) =>
          s.remaining_g === 0
            ? `slot ${s.slot} is out of filament`
            : `slot ${s.slot} is low (~${s.remaining_g} g left)`,
        )
        .join("; "),
      filament_remaining_g: filamentRemainingG,
    };
  }

  return {
    slots,
    needs_filament_swap: false,
    filament_swap_reason: null,
    filament_remaining_g: filamentRemainingG,
  };
}

/**
 * Build a slot -> spool-summary lookup for the fleet's Spoolman-backed
 * filaments. Fetches each referenced Spoolman integration once and caches the
 * result for the life of the returned closure, so a farm-status call makes at
 * most one HTTP request per Spoolman integration regardless of fleet size.
 *
 * Never throws: an unreachable or misconfigured Spoolman degrades every slot to
 * "remaining unknown", which the swap logic treats as "no opinion" rather than
 * a false low-filament alarm.
 */
export async function buildSpoolLookup(
  repo: AppRepository,
  colorIds: Iterable<string | null | undefined>,
): Promise<SpoolLookup> {
  const integrationIds = new Set<string>();
  for (const raw of colorIds) {
    const parsed = parseSpoolmanFilamentId((raw ?? "").trim());
    if (parsed) integrationIds.add(parsed.integrationId);
  }

  const spoolsByIntegration = new Map<string, SpoolmanSpool[]>();

  await Promise.all(
    [...integrationIds].map(async (integrationId) => {
      try {
        const integration = getIntegrationConfig(repo, integrationId);
        if (!integration || integration.type !== "spoolman") return;
        if (integration.config.enabled === false) return;
        spoolsByIntegration.set(integrationId, await listSpoolmanSpools(integration.config));
      } catch {
        /* Spoolman unavailable — slots stay "unknown", not "empty". */
      }
    }),
  );

  return (colorId: string): SpoolSummary[] | null => {
    const parsed = parseSpoolmanFilamentId((colorId ?? "").trim());
    if (!parsed) return null;
    const spools = spoolsByIntegration.get(parsed.integrationId);
    // The id names an integration we could not read: unknown, NOT depleted.
    // Returning [] here would report 0 g and raise a false swap alert.
    if (!spools) return null;
    return spoolSummariesForFilament(spools, parsed.filamentId);
  };
}

export type PrintJobLike = {
  printerId?: string | null;
  status?: string | null;
  filamentConsumedG?: number | null;
  at: string;
  completedAt?: string | null;
};

/**
 * Most recent print activity per printer, used to answer "Prusa XL idle since
 * 3am". Prefers completedAt (when the machine actually went quiet) and falls
 * back to the send timestamp for jobs with no recorded completion.
 */
export function lastActivityByPrinter(jobs: PrintJobLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const job of jobs) {
    const printerId = (job.printerId ?? "").trim();
    if (!printerId) continue;
    const at = job.completedAt ?? job.at;
    if (!at) continue;
    const existing = out.get(printerId);
    if (!existing || at > existing) out.set(printerId, at);
  }
  return out;
}

/**
 * `idle_since` for a printer: the moment its last job finished, but only when
 * the printer is actually idle. A printing machine is not idle, and a printer
 * with no job in the lookback window reports null rather than a misleading
 * "idle since the beginning of time".
 */
export function idleSinceFor(
  state: string,
  printerId: string,
  lastActivity: Map<string, string>,
): string | null {
  if (state === "printing" || state === "paused") return null;
  return lastActivity.get(printerId) ?? null;
}

export type PrinterPrintStats = {
  printer_id: string;
  plates_sent: number;
  plates_completed: number;
  plates_failed: number;
  filament_consumed_g: number;
  /** completed / (completed + failed); null when nothing has finished either way. */
  completion_rate: number | null;
};

/** completed / (completed + failed), rounded to 3 dp; null when undefined. */
export function completionRate(completed: number, failed: number): number | null {
  const finished = completed + failed;
  if (finished <= 0) return null;
  return Math.round((completed / finished) * 1000) / 1000;
}

/** Per-printer rollup of print_jobs rows, sorted by printer id for stable output. */
export function printStatsByPrinter(jobs: PrintJobLike[]): PrinterPrintStats[] {
  const byPrinter = new Map<string, PrinterPrintStats>();
  for (const job of jobs) {
    const printerId = (job.printerId ?? "").trim() || "unassigned";
    let row = byPrinter.get(printerId);
    if (!row) {
      row = {
        printer_id: printerId,
        plates_sent: 0,
        plates_completed: 0,
        plates_failed: 0,
        filament_consumed_g: 0,
        completion_rate: null,
      };
      byPrinter.set(printerId, row);
    }
    row.plates_sent += 1;
    if (job.status === "completed") row.plates_completed += 1;
    if (job.status === "failed") row.plates_failed += 1;
    row.filament_consumed_g += job.filamentConsumedG ?? 0;
  }
  for (const row of byPrinter.values()) {
    row.completion_rate = completionRate(row.plates_completed, row.plates_failed);
  }
  return [...byPrinter.values()].sort((a, b) => a.printer_id.localeCompare(b.printer_id));
}

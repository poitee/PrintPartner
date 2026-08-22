/**
 * spoolman-deduct.ts
 *
 * Best-effort filament deduction from Spoolman after a print is confirmed.
 *
 * Strategy:
 *  1. Fetch total filament consumed (mm) from the printer API for the job.
 *  2. Look up which Spoolman spools are assigned to the confirmed parts.
 *  3. Distribute the consumed filament across spools proportionally by
 *     number of confirmed units that use each spool.
 *  4. Call Spoolman PUT /spool/:id/use for each spool.
 *
 * All failures are logged and swallowed — deduction is best-effort and must
 * never block checkoff.
 */

import type { AppRepository } from "../db/repository.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { getIntegrationConfig, listIntegrationsByType } from "../integrations/store.js";
import { parseSpoolmanSpoolId, useSpoolFilament as deductSpoolFilament } from "../integrations/spoolman-client.js";
import { getLogger } from "./logger.js";
import type { PrintVerifyDecision } from "@print-partner/contracts";

/**
 * After a verify confirms one or more units, attempt to deduct the
 * consumed filament weight from the relevant Spoolman spools.
 *
 * @param repo                  App repository for settings + part data.
 * @param printerIntegrationId  The integration that printed the job.
 * @param profileId             Plan profile whose parts were confirmed.
 * @param confirmedDecisions    The decisions with result === "confirmed".
 * @param totalUnitsInLink      Total unit count in the checkoff link (for proportional split).
 */
export async function deductSpoolmanFilamentAfterVerify(
  repo: AppRepository,
  printerIntegrationId: string,
  profileId: number,
  confirmedDecisions: PrintVerifyDecision[],
  totalUnitsInLink: number,
): Promise<void> {
  if (!confirmedDecisions.length) return;

  const log = getLogger();

  // --- Step 1: Get filament consumed from printer ---
  let filamentUsedMm: number | null = null;
  try {
    const printerIntegration = getIntegrationConfig(repo, printerIntegrationId);
    if (printerIntegration) {
      const adapter = getIntegrationAdapter(printerIntegration.type);
      if (adapter?.getFilamentUsed) {
        filamentUsedMm = await adapter.getFilamentUsed(printerIntegration.config);
      }
    }
  } catch (err) {
    log.log(
      "warn",
      `spoolman-deduct: failed to fetch filament from printer: ${err}`,
    );
  }

  if (filamentUsedMm == null || filamentUsedMm <= 0) {
    return;
  }

  // --- Step 2: Find Spoolman integration ---
  const spoolmanIntegrations = listIntegrationsByType(repo, "spoolman");
  if (!spoolmanIntegrations.length) return;
  // Use the most-recently-updated Spoolman integration.
  const spoolmanIntegration = spoolmanIntegrations[0]!;

  // --- Step 3: Resolve spool assignments for confirmed parts ---
  const partRows = repo.getProfilePartRows(profileId);
  const partById = new Map(partRows.map((p) => [p.id, p]));

  // Count confirmed units per spool reference
  const spoolUnitCounts = new Map<string, number>(); // spoolRef -> count
  for (const d of confirmedDecisions) {
    const part = partById.get(d.part_id);
    if (!part?.spoolmanSpoolId) continue;
    const spoolRef = part.spoolmanSpoolId;
    spoolUnitCounts.set(spoolRef, (spoolUnitCounts.get(spoolRef) ?? 0) + 1);
  }

  if (!spoolUnitCounts.size) {
    return;
  }

  // --- Step 4: Distribute filament proportionally ---
  // Scale by (confirmed units / total link units) so we don't over-deduct
  // when only some units in a multi-part print are confirmed.
  const confirmedCount = confirmedDecisions.length;
  const totalCount = Math.max(totalUnitsInLink, confirmedCount);
  const scaledMm = filamentUsedMm * (confirmedCount / totalCount);

  const totalConfirmedWithSpool = Array.from(spoolUnitCounts.values()).reduce(
    (sum, c) => sum + c,
    0,
  );

  for (const [spoolRef, unitCount] of spoolUnitCounts) {
    const parsed = parseSpoolmanSpoolId(spoolRef);
    if (!parsed) continue;

    const fraction = unitCount / totalConfirmedWithSpool;
    const deductMm = scaledMm * fraction;
    if (deductMm < 0.1) continue; // Skip negligible amounts

    try {
      await deductSpoolFilament(spoolmanIntegration.config, parsed.spoolId, deductMm);
      log.log("info", `spoolman-deduct: deducted ${Math.round(deductMm)} mm from spool #${parsed.spoolId}`);
    } catch (err) {
      log.log("warn", `spoolman-deduct: failed to deduct from spool #${parsed.spoolId}: ${err}`);
    }
  }
}

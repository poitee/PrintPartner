import { describe, expect, it } from "vitest";
import {
  LOW_FILAMENT_THRESHOLD_G,
  completionRate,
  hostReportsFilamentRunout,
  idleSinceFor,
  lastActivityByPrinter,
  printStatsByPrinter,
  printerFilamentStatus,
  slotFilamentStatus,
  type SpoolLookup,
} from "./farm-filament.js";
import type { SpoolSummary } from "../integrations/spoolman-client.js";

/**
 * Unit coverage for the farm-status / print-stats derivations that back the
 * get_farm_status and get_print_stats MCP tools: filament remaining per
 * spool/printer, the filament-swap verdict, idle-since, and completion rates.
 *
 * These are the judgement calls the morning digest depends on ("CoreOne1 needs
 * filament swap", "Prusa XL idle since 3am"), so they're tested here in
 * isolation from Spoolman HTTP and live printer hosts.
 */

const SPOOLMAN_ID = (filamentId: number) => `spoolman:workshop:filament:${filamentId}`;

/** Lookup over a fixed filamentId -> spools table; unknown ids are "not tracked". */
function lookupFrom(table: Record<number, SpoolSummary[]>): SpoolLookup {
  return (colorId: string) => {
    const m = /^spoolman:workshop:filament:(\d+)$/.exec(colorId);
    if (!m) return null;
    return table[Number(m[1])] ?? [];
  };
}

const slot = (n: number, colorId: string | null, label = "") => ({
  slot: n,
  filament_color_id: colorId,
  label,
});

describe("slotFilamentStatus", () => {
  it("sums remaining grams across every spool backing the slot's filament", () => {
    const lookup = lookupFrom({ 7: [{ spool_id: 1, remaining_g: 480 }, { spool_id: 2, remaining_g: 310 }] });
    const status = slotFilamentStatus(slot(1, SPOOLMAN_ID(7), "LDO Black"), lookup);

    expect(status.remaining_g).toBe(790);
    expect(status.spool_ids).toEqual([1, 2]);
    expect(status.empty).toBe(false);
    expect(status.low).toBe(false);
    expect(status.label).toBe("LDO Black");
  });

  it("marks a slot with no filament assigned as empty, with remaining unknown", () => {
    const status = slotFilamentStatus(slot(1, null), lookupFrom({}));
    expect(status.empty).toBe(true);
    // Distinct from 0: nothing is loaded, so there is no inventory figure at all.
    expect(status.remaining_g).toBeNull();
    expect(status.low).toBe(false);
  });

  it("reports a non-Spoolman (catalog/custom) filament as untracked, not as 0 g", () => {
    // A catalog colour id is a colour choice, not an inventory record. Reporting
    // it as 0 g would fire a false low-filament alarm on every such printer.
    const status = slotFilamentStatus(slot(1, "catalog:prusament-galaxy-black"), lookupFrom({}));
    expect(status.remaining_g).toBeNull();
    expect(status.empty).toBe(false);
    expect(status.low).toBe(false);
  });

  it("flags a slot at or below the low threshold, and 0 g when every spool is depleted", () => {
    const atThreshold = slotFilamentStatus(
      slot(1, SPOOLMAN_ID(7)),
      lookupFrom({ 7: [{ spool_id: 1, remaining_g: LOW_FILAMENT_THRESHOLD_G }] }),
    );
    expect(atThreshold.low).toBe(true);

    const justAbove = slotFilamentStatus(
      slot(1, SPOOLMAN_ID(7)),
      lookupFrom({ 7: [{ spool_id: 1, remaining_g: LOW_FILAMENT_THRESHOLD_G + 1 }] }),
    );
    expect(justAbove.low).toBe(false);

    // Spoolman knows this filament and has no spools left of it -> genuinely 0.
    const depleted = slotFilamentStatus(slot(1, SPOOLMAN_ID(9)), lookupFrom({ 9: [] }));
    expect(depleted.remaining_g).toBe(0);
    expect(depleted.low).toBe(true);
  });

  it("degrades to unknown (not empty, not low) when the spool lookup is unavailable or throws", () => {
    const unavailable = slotFilamentStatus(slot(1, SPOOLMAN_ID(7)), () => null);
    expect(unavailable.remaining_g).toBeNull();
    expect(unavailable.low).toBe(false);

    const throwing = slotFilamentStatus(slot(1, SPOOLMAN_ID(7)), () => {
      throw new Error("spoolman unreachable");
    });
    expect(throwing.remaining_g).toBeNull();
    expect(throwing.low).toBe(false);
  });
});

describe("hostReportsFilamentRunout", () => {
  it("detects runout phrasing across the host dialects we talk to", () => {
    for (const message of [
      "Filament runout detected",
      "filament run out",
      "Please load filament",
      "Filament sensor triggered",
      "Out of filament",
      "Filament jam",
    ]) {
      expect(hostReportsFilamentRunout({ state: "paused", message })).toBe(true);
    }
  });

  it("does not fire on unrelated messages, or on a missing status", () => {
    expect(hostReportsFilamentRunout({ state: "printing", message: "Printing plate 3" })).toBe(false);
    expect(hostReportsFilamentRunout({ state: "paused", message: "Paused by user" })).toBe(false);
    expect(hostReportsFilamentRunout({ state: "idle" })).toBe(false);
    expect(hostReportsFilamentRunout(null)).toBe(false);
    expect(hostReportsFilamentRunout(undefined)).toBe(false);
  });
});

describe("printerFilamentStatus", () => {
  const machine = (slots: Array<{ slot: number; filament_color_id: string | null; label: string }>) =>
    ({ loaded_filaments: slots }) as Parameters<typeof printerFilamentStatus>[0];

  it("reports a healthy printer as needing no swap and totals its tracked slots", () => {
    const status = printerFilamentStatus(
      machine([slot(1, SPOOLMAN_ID(7), "LDO Black"), slot(2, SPOOLMAN_ID(8), "PETG")]),
      lookupFrom({ 7: [{ spool_id: 1, remaining_g: 600 }], 8: [{ spool_id: 2, remaining_g: 400 }] }),
      { state: "printing" },
    );

    expect(status.needs_filament_swap).toBe(false);
    expect(status.filament_swap_reason).toBeNull();
    expect(status.filament_remaining_g).toBe(1000);
  });

  it("flags a low spool as needing a swap and names the slot and grams left", () => {
    const status = printerFilamentStatus(
      machine([slot(1, SPOOLMAN_ID(7), "LDO Black")]),
      lookupFrom({ 7: [{ spool_id: 1, remaining_g: 40 }] }),
      { state: "idle" },
    );

    expect(status.needs_filament_swap).toBe(true);
    expect(status.filament_swap_reason).toMatch(/slot 1 is low/);
    expect(status.filament_swap_reason).toMatch(/40 g/);
    expect(status.filament_remaining_g).toBe(40);
  });

  it("flags an empty slot ahead of any low-spool reasoning", () => {
    const status = printerFilamentStatus(
      machine([slot(1, null, ""), slot(2, SPOOLMAN_ID(7), "PETG")]),
      lookupFrom({ 7: [{ spool_id: 1, remaining_g: 10 }] }),
      { state: "idle" },
    );

    expect(status.needs_filament_swap).toBe(true);
    expect(status.filament_swap_reason).toMatch(/no filament loaded in slot 1/);
    // Slot 2 is still tracked, so the printer total reflects what IS loaded.
    expect(status.filament_remaining_g).toBe(10);
  });

  it("lets a host-reported runout win over inventory, even when spools look full", () => {
    const status = printerFilamentStatus(
      machine([slot(1, SPOOLMAN_ID(7), "LDO Black")]),
      lookupFrom({ 7: [{ spool_id: 1, remaining_g: 900 }] }),
      { state: "paused", message: "Filament runout detected" },
    );

    expect(status.needs_filament_swap).toBe(true);
    expect(status.filament_swap_reason).toMatch(/reports filament runout/);
    expect(status.filament_swap_reason).toMatch(/Filament runout detected/);
    // Inventory is still reported alongside the runout — the spool has plenty,
    // which is exactly the signal that the jam is mechanical, not an empty spool.
    expect(status.filament_remaining_g).toBe(900);
  });

  it("reports remaining as unknown (null) rather than 0 when nothing is tracked", () => {
    const status = printerFilamentStatus(
      machine([slot(1, "catalog:prusament-galaxy-black", "Galaxy Black")]),
      lookupFrom({}),
      { state: "idle" },
    );

    expect(status.filament_remaining_g).toBeNull();
    expect(status.needs_filament_swap).toBe(false);
  });

  it("handles a machine with no slots at all without throwing", () => {
    const status = printerFilamentStatus(machine([]), lookupFrom({}), { state: "idle" });
    expect(status.slots).toEqual([]);
    expect(status.needs_filament_swap).toBe(false);
    expect(status.filament_remaining_g).toBeNull();
  });
});

describe("lastActivityByPrinter / idleSinceFor", () => {
  it("prefers completedAt and keeps the most recent moment per printer", () => {
    const map = lastActivityByPrinter([
      { printerId: "prusa-xl", at: "2026-08-16T01:00:00.000Z", completedAt: "2026-08-16T03:00:00.000Z" },
      { printerId: "prusa-xl", at: "2026-08-16T00:00:00.000Z", completedAt: "2026-08-16T02:00:00.000Z" },
      // No completion recorded — falls back to the send timestamp.
      { printerId: "trident-r2", at: "2026-08-16T05:00:00.000Z", completedAt: null },
    ]);

    expect(map.get("prusa-xl")).toBe("2026-08-16T03:00:00.000Z");
    expect(map.get("trident-r2")).toBe("2026-08-16T05:00:00.000Z");
  });

  it("ignores rows with no printer attribution", () => {
    const map = lastActivityByPrinter([
      { printerId: "", at: "2026-08-16T01:00:00.000Z" },
      { printerId: null, at: "2026-08-16T02:00:00.000Z" },
    ]);
    expect(map.size).toBe(0);
  });

  it("reports idle_since only for a printer that is actually idle", () => {
    const map = new Map([["prusa-xl", "2026-08-16T03:00:00.000Z"]]);

    expect(idleSinceFor("idle", "prusa-xl", map)).toBe("2026-08-16T03:00:00.000Z");
    expect(idleSinceFor("complete", "prusa-xl", map)).toBe("2026-08-16T03:00:00.000Z");
    // A running machine is not idle, no matter when it last finished something.
    expect(idleSinceFor("printing", "prusa-xl", map)).toBeNull();
    expect(idleSinceFor("paused", "prusa-xl", map)).toBeNull();
    // No recorded activity -> null, not a misleading epoch timestamp.
    expect(idleSinceFor("idle", "coreone1", map)).toBeNull();
  });
});

describe("completionRate / printStatsByPrinter", () => {
  it("computes completed / (completed + failed) and stays null with nothing finished", () => {
    expect(completionRate(3, 1)).toBe(0.75);
    expect(completionRate(5, 0)).toBe(1);
    expect(completionRate(0, 2)).toBe(0);
    // Only in-flight jobs: a rate would be a lie, so it stays undefined.
    expect(completionRate(0, 0)).toBeNull();
  });

  it("rolls print jobs up per printer with rates and filament totals", () => {
    const rows = printStatsByPrinter([
      { printerId: "trident-r2", status: "completed", filamentConsumedG: 42, at: "2026-08-16T01:00:00.000Z" },
      { printerId: "trident-r2", status: "completed", filamentConsumedG: 38, at: "2026-08-16T02:00:00.000Z" },
      { printerId: "trident-r2", status: "failed", filamentConsumedG: 10, at: "2026-08-16T03:00:00.000Z" },
      // Still in flight: counted as sent, excluded from the completion rate.
      { printerId: "trident-r2", status: "sent", filamentConsumedG: null, at: "2026-08-16T04:00:00.000Z" },
      { printerId: "prusa-xl", status: "completed", filamentConsumedG: 55, at: "2026-08-16T01:30:00.000Z" },
    ]);

    expect(rows.map((r) => r.printer_id)).toEqual(["prusa-xl", "trident-r2"]); // stable ordering

    const trident = rows.find((r) => r.printer_id === "trident-r2")!;
    expect(trident.plates_sent).toBe(4);
    expect(trident.plates_completed).toBe(2);
    expect(trident.plates_failed).toBe(1);
    expect(trident.filament_consumed_g).toBe(90);
    expect(trident.completion_rate).toBeCloseTo(2 / 3, 3);

    const xl = rows.find((r) => r.printer_id === "prusa-xl")!;
    expect(xl.completion_rate).toBe(1);
  });

  it("buckets jobs with no printer attribution under 'unassigned' instead of dropping them", () => {
    const rows = printStatsByPrinter([
      { printerId: "", status: "completed", filamentConsumedG: 20, at: "2026-08-16T01:00:00.000Z" },
      { printerId: null, status: "failed", filamentConsumedG: 5, at: "2026-08-16T02:00:00.000Z" },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.printer_id).toBe("unassigned");
    expect(rows[0]!.plates_sent).toBe(2);
    expect(rows[0]!.completion_rate).toBe(0.5);
  });

  it("returns an empty rollup for an empty job list", () => {
    expect(printStatsByPrinter([])).toEqual([]);
  });
});

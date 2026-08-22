import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { ASSISTANT_TOOL_SPECS, invokeAssistantTool } from "./tools.js";
import { loadFleet, saveFleet } from "../services/printer-fleet.js";
import { createIntegrationPort, type IntegrationPort } from "../integrations/store.js";
import { spoolmanAdapter } from "../integrations/adapters/spoolman.js";
import type { PrinterHostStatus } from "@print-partner/contracts";
import type { PrinterMachine } from "@print-partner/domain";
import { getLogger } from "../services/logger.js";

/** A fleet machine with one empty filament slot, bound to `integrationId`. */
function machine(id: string, name: string, integrationId: string | null): PrinterMachine {
  return {
    id,
    name,
    model: name,
    bed_width_mm: 250,
    bed_depth_mm: 250,
    bed_height_mm: 250,
    margin_mm: 4,
    max_filament_slots: 1,
    loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
    integration_id: integrationId,
  };
}

/** IntegrationPort whose getStatus resolves from `statuses` and throws otherwise. */
function integrationPort(statuses: Record<string, PrinterHostStatus>): IntegrationPort {
  return {
    getStatus: async (id: string) => {
      const s = statuses[id];
      if (!s) throw new Error("offline");
      return s;
    },
  } as unknown as IntegrationPort;
}

/**
 * Schema-v9-era print_jobs audit: end-to-end validation that get_farm_status
 * and get_print_stats (added on top of the print_jobs table) can read every
 * field the MCP tool contract promises, using representative sample data
 * (an idle printer, an actively printing printer, an offline printer, and a
 * mix of completed/failed/sent jobs across the lookback window).
 */
describe("print_jobs schema supports get_farm_status / get_print_stats", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-farm-status-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("describes the accepted Progress collection to the model", () => {
    const spec = ASSISTANT_TOOL_SPECS.find(({ name }) => name === "get_print_stats");
    expect(spec?.description).toBe(
      "Recent print activity and accepted Plan progress. Returns plates sent in the last N hours, completed and failed counts, completion rate, filament consumed, and a per-printer breakdown. active_plans is either an available collection or unavailable when collection loading fails. Each available Plan has plan_id, plan_name, part_count, and accepted_progress. accepted_progress is ready with total_units and remaining_units, empty when nothing has been applied, or unavailable with reason compatibility_dirty, uninitialized, integrity, or concurrent_update. Per-Plan unavailable states remain inside an available collection. Pass hours to control the lookback window.",
    );
  });

  it("get_farm_status reports printer state + active job for each fleet machine", async () => {
    saveFleet(repo, [
      {
        id: "trident-r2",
        name: "Trident R2 LDO",
        model: "Trident R2 LDO",
        bed_width_mm: 250,
        bed_depth_mm: 250,
        bed_height_mm: 250,
        margin_mm: 4,
        max_filament_slots: 1,
        loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
        integration_id: "moonraker-trident",
      },
      {
        id: "prusa-xl",
        name: "Prusa XL",
        model: "Prusa XL",
        bed_width_mm: 360,
        bed_depth_mm: 360,
        bed_height_mm: 360,
        margin_mm: 4,
        max_filament_slots: 1,
        loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
        integration_id: "moonraker-xl",
      },
      {
        id: "coreone1",
        name: "CoreOne1",
        model: "CoreOne1",
        bed_width_mm: 250,
        bed_depth_mm: 220,
        bed_height_mm: 270,
        margin_mm: 4,
        max_filament_slots: 1,
        loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
        integration_id: null,
      },
    ]);
    expect(loadFleet(repo)).toHaveLength(3);

    const statuses: Record<string, PrinterHostStatus> = {
      "moonraker-trident": { state: "printing", filename: "plate_ldo.gcode", progress: 42 },
      "moonraker-xl": { state: "idle", filename: undefined },
    };
    const integrations: IntegrationPort = {
      getStatus: async (id: string) => {
        const s = statuses[id];
        if (!s) throw new Error("offline");
        return s;
      },
    } as unknown as IntegrationPort;

    const result = await invokeAssistantTool("get_farm_status", {}, { repo, integrations });
    const data = JSON.parse(result.content);

    expect(data.printer_count).toBe(3);
    expect(data.printers).toHaveLength(3);

    const trident = data.printers.find((p: { id: string }) => p.id === "trident-r2");
    expect(trident.state).toBe("printing");
    expect(trident.active_job).toBe("plate_ldo.gcode");

    const xl = data.printers.find((p: { id: string }) => p.id === "prusa-xl");
    expect(xl.state).toBe("idle");

    // CoreOne1 has no integration bound — surfaces as unknown, not a crash.
    const coreone = data.printers.find((p: { id: string }) => p.id === "coreone1");
    expect(coreone.state).toBe("unknown");

    expect(data.printing).toBe(1);
    expect(data.idle).toBe(1);
    // "unknown" (no integration bound) is bucketed together with "offline"
    // by get_farm_status's own aggregate logic — assert all 3 machines are
    // accounted for across the three buckets, none silently dropped.
    expect(data.idle + data.printing + data.offline).toBe(3);
  });

  it("get_print_stats aggregates print_jobs rows written via insertPrintJob", async () => {
    const plan = repo.createProfile("Trident Plate Run");

    const now = Date.now();
    const jobs = [
      { status: "completed", printerId: "trident-r2", material: "LDO PLA", filamentConsumedG: 42, hoursAgo: 1 },
      { status: "completed", printerId: "trident-r2", material: "LDO PLA", filamentConsumedG: 38, hoursAgo: 3 },
      { status: "completed", printerId: "prusa-xl", material: "PETG", filamentConsumedG: 55, hoursAgo: 6 },
      { status: "failed", printerId: "coreone1", material: "ABS", filamentConsumedG: 10, hoursAgo: 2 },
      { status: "sent", printerId: "trident-r2", material: "LDO PLA", filamentConsumedG: null, hoursAgo: 0.2 },
      // outside the default 8h lookback window — must NOT be counted
      { status: "completed", printerId: "prusa-xl", material: "PETG", filamentConsumedG: 999, hoursAgo: 30 },
    ];

    for (const j of jobs) {
      const at = new Date(now - j.hoursAgo * 3600 * 1000).toISOString();
      repo.insertPrintJob({
        id: randomUUID(),
        profileId: plan.id,
        printerId: j.printerId,
        material: j.material,
        status: j.status,
        filamentConsumedG: j.filamentConsumedG ?? undefined,
        at,
        completedAt: j.status === "completed" ? at : undefined,
      });
    }

    const result = await invokeAssistantTool("get_print_stats", {}, { repo });
    const data = JSON.parse(result.content);

    expect(data.window_hours).toBe(8);
    expect(data.plates_sent).toBe(5); // 6 total minus the 30h-old row outside the window
    expect(data.plates_completed).toBe(3);
    expect(data.plates_failed).toBe(1);
    expect(data.filament_consumed_g).toBe(42 + 38 + 55 + 10); // excludes the null and the out-of-window row
    expect(data.active_plans.kind).toBe("available");
    expect(
      data.active_plans.plans.some((p: { plan_id: number }) => p.plan_id === plan.id),
    ).toBe(true);

    // custom window: widen to 48h to pick up the previously-excluded row
    const wide = JSON.parse(
      (await invokeAssistantTool("get_print_stats", { hours: 48 }, { repo })).content,
    );
    expect(wide.plates_sent).toBe(6);
    expect(wide.plates_completed).toBe(4);
  });

  it("get_print_stats does not error when print_jobs is empty (fresh v9+ schema)", async () => {
    const result = await invokeAssistantTool("get_print_stats", {}, { repo });
    const data = JSON.parse(result.content);
    expect(data.plates_sent).toBe(0);
    expect(data.plates_completed).toBe(0);
    expect(data.plates_failed).toBe(0);
    expect(data.filament_consumed_g).toBe(0);
  });

  it("get_print_stats returns an available mixed accepted Progress collection", async () => {
    const ready = repo.createProfile("A Ready");
    const empty = repo.createProfile("B Empty");
    const dirty = repo.createProfile("C Dirty");
    const uninitialized = repo.createProfile("D Uninitialized");
    const integrity = repo.createProfile("E Integrity");
    const concurrent = repo.createProfile("F Concurrent");
    const archived = repo.createProfile("G Archived");
    const readyHeader = repo.getProfileHeader(ready.id);
    const emptyHeader = repo.getProfileHeader(empty.id);
    const dirtyHeader = repo.getProfileHeader(dirty.id);
    const uninitializedHeader = repo.getProfileHeader(uninitialized.id);
    const integrityHeader = repo.getProfileHeader(integrity.id);
    const concurrentHeader = repo.getProfileHeader(concurrent.id);
    const archivedHeader = repo.getProfileHeader(archived.id);
    if (
      !readyHeader ||
      !emptyHeader ||
      !dirtyHeader ||
      !uninitializedHeader ||
      !integrityHeader ||
      !concurrentHeader ||
      !archivedHeader
    ) {
      throw new Error("test Profile header is missing");
    }
    repo.listAcceptedProfileSummaries = () => [
      { header: readyHeader, progress: { kind: "ready", totalUnits: 4, remainingUnits: 2 } },
      { header: emptyHeader, progress: { kind: "empty" } },
      {
        header: dirtyHeader,
        progress: { kind: "unavailable", reason: "compatibility_dirty" },
      },
      {
        header: uninitializedHeader,
        progress: { kind: "unavailable", reason: "uninitialized" },
      },
      { header: integrityHeader, progress: { kind: "integrity_failure", code: "progress" } },
      { header: concurrentHeader, progress: { kind: "concurrent_update" } },
      {
        header: { ...archivedHeader, archived_at: "2026-08-21T12:00:00.000Z" },
        progress: { kind: "ready", totalUnits: 9, remainingUnits: 9 },
      },
    ];

    const data = JSON.parse((await invokeAssistantTool("get_print_stats", {}, { repo })).content);
    expect(data.active_plans).toEqual({
      kind: "available",
      plans: [
        {
          plan_id: ready.id,
          plan_name: "A Ready",
          part_count: 0,
          accepted_progress: { kind: "ready", total_units: 4, remaining_units: 2 },
        },
        {
          plan_id: empty.id,
          plan_name: "B Empty",
          part_count: 0,
          accepted_progress: { kind: "empty" },
        },
        {
          plan_id: dirty.id,
          plan_name: "C Dirty",
          part_count: 0,
          accepted_progress: { kind: "unavailable", reason: "compatibility_dirty" },
        },
        {
          plan_id: uninitialized.id,
          plan_name: "D Uninitialized",
          part_count: 0,
          accepted_progress: { kind: "unavailable", reason: "uninitialized" },
        },
        {
          plan_id: integrity.id,
          plan_name: "E Integrity",
          part_count: 0,
          accepted_progress: { kind: "unavailable", reason: "integrity" },
        },
        {
          plan_id: concurrent.id,
          plan_name: "F Concurrent",
          part_count: 0,
          accepted_progress: { kind: "unavailable", reason: "concurrent_update" },
        },
      ],
    });
  });

  it("get_print_stats preserves non-Plan stats and redacts collection failures", async () => {
    repo.listAcceptedProfileSummaries = () => {
      throw new Error("secret SQL /private/path token_123");
    };
    const log = vi.spyOn(getLogger(), "log").mockImplementation(() => undefined);

    const data = JSON.parse((await invokeAssistantTool("get_print_stats", {}, { repo })).content);
    expect(data).toEqual(
      expect.objectContaining({
        plates_sent: 0,
        plates_completed: 0,
        plates_failed: 0,
        filament_consumed_g: 0,
        by_printer: [],
        active_plans: { kind: "unavailable" },
      }),
    );
    expect(data.error).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("secret SQL");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret SQL");
    expect(log).toHaveBeenCalledWith(
      "error",
      "[assistant] Plan progress collection unavailable",
      { failure: "unexpected", operation: "get_print_stats" },
    );
  });

  it("get_farm_status does not error when fleet is empty", async () => {
    const result = await invokeAssistantTool("get_farm_status", {}, { repo });
    const data = JSON.parse(result.content);
    expect(data.printer_count).toBe(0);
    expect(data.printers).toEqual([]);
  });

  it("get_farm_status tolerates garbage/non-object input instead of throwing", async () => {
    // get_farm_status takes no parameters; a model that hallucinates args (or a
    // caller that passes null/an array/a primitive) must not crash the tool.
    for (const badInput of [null, undefined, "not-an-object", 42, ["x"]] as unknown as Record<
      string,
      unknown
    >[]) {
      const result = await invokeAssistantTool("get_farm_status", badInput, { repo });
      const data = JSON.parse(result.content);
      expect(data.printer_count).toBe(0);
      expect(data.error).toBeUndefined();
    }
  });

  it("get_print_stats rejects a non-positive or non-numeric hours value", async () => {
    for (const badHours of [0, -5, "not-a-number", NaN, Infinity, {}, []]) {
      const result = await invokeAssistantTool(
        "get_print_stats",
        { hours: badHours as unknown as number },
        { repo },
      );
      const data = JSON.parse(result.content);
      expect(data.error).toMatch(/hours must be a positive number/);
    }
  });

  it("get_print_stats rejects an absurdly large hours window", async () => {
    const result = await invokeAssistantTool(
      "get_print_stats",
      { hours: 24 * 365 }, // 1 year, well past the 90-day cap
      { repo },
    );
    const data = JSON.parse(result.content);
    expect(data.error).toMatch(/hours must be .* or less/);
  });

  it("get_print_stats accepts a numeric-string hours value", async () => {
    const result = await invokeAssistantTool("get_print_stats", { hours: "24" as unknown as number }, { repo });
    const data = JSON.parse(result.content);
    expect(data.error).toBeUndefined();
    expect(data.window_hours).toBe(24);
  });

  it("get_print_stats reports a completion rate and a per-printer breakdown", async () => {
    const plan = repo.createProfile("Rate Plan");
    const now = Date.now();
    const jobs = [
      { status: "completed", printerId: "trident-r2", filamentConsumedG: 42, hoursAgo: 1 },
      { status: "completed", printerId: "trident-r2", filamentConsumedG: 38, hoursAgo: 2 },
      { status: "failed", printerId: "trident-r2", filamentConsumedG: 10, hoursAgo: 3 },
      // Still in flight — counted as sent, excluded from the rate denominator.
      { status: "sent", printerId: "trident-r2", filamentConsumedG: null, hoursAgo: 0.1 },
      { status: "completed", printerId: "prusa-xl", filamentConsumedG: 55, hoursAgo: 4 },
    ];
    for (const j of jobs) {
      const at = new Date(now - j.hoursAgo * 3600 * 1000).toISOString();
      repo.insertPrintJob({
        id: randomUUID(),
        profileId: plan.id,
        printerId: j.printerId,
        material: "PLA",
        status: j.status,
        filamentConsumedG: j.filamentConsumedG ?? undefined,
        at,
        completedAt: j.status === "completed" ? at : undefined,
      });
    }

    const data = JSON.parse((await invokeAssistantTool("get_print_stats", {}, { repo })).content);

    // 3 completed / (3 completed + 1 failed) — the "sent" row is in flight.
    expect(data.completion_rate).toBe(0.75);

    const trident = data.by_printer.find((p: { printer_id: string }) => p.printer_id === "trident-r2");
    expect(trident.plates_sent).toBe(4);
    expect(trident.plates_completed).toBe(2);
    expect(trident.plates_failed).toBe(1);
    expect(trident.filament_consumed_g).toBe(90);
    expect(trident.completion_rate).toBeCloseTo(2 / 3, 3);

    const xl = data.by_printer.find((p: { printer_id: string }) => p.printer_id === "prusa-xl");
    expect(xl.plates_completed).toBe(1);
    expect(xl.completion_rate).toBe(1);
  });

  it("get_print_stats leaves completion_rate null when nothing has finished yet", async () => {
    const plan = repo.createProfile("In Flight");
    repo.insertPrintJob({
      id: randomUUID(),
      profileId: plan.id,
      printerId: "trident-r2",
      material: "PLA",
      status: "sent",
      at: new Date().toISOString(),
    });

    const data = JSON.parse((await invokeAssistantTool("get_print_stats", {}, { repo })).content);
    expect(data.plates_sent).toBe(1);
    expect(data.completion_rate).toBeNull();
  });

  it("get_farm_status reports idle_since from the printer's last finished job", async () => {
    saveFleet(repo, [machine("prusa-xl", "Prusa XL", "moonraker-xl")]);
    const plan = repo.createProfile("Overnight");

    const finishedAt = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    repo.insertPrintJob({
      id: randomUUID(),
      profileId: plan.id,
      printerId: "prusa-xl",
      material: "PLA",
      status: "completed",
      at: new Date(Date.now() - 9 * 3600 * 1000).toISOString(),
      completedAt: finishedAt,
    });

    const integrations = integrationPort({ "moonraker-xl": { state: "idle" } });
    const data = JSON.parse(
      (await invokeAssistantTool("get_farm_status", {}, { repo, integrations })).content,
    );

    const xl = data.printers.find((p: { id: string }) => p.id === "prusa-xl");
    expect(xl.state).toBe("idle");
    expect(xl.idle_since).toBe(finishedAt);
  });

  it("get_farm_status reports no idle_since for a printer that is currently printing", async () => {
    saveFleet(repo, [machine("trident-r2", "Trident R2 LDO", "moonraker-trident")]);
    const plan = repo.createProfile("Running");
    repo.insertPrintJob({
      id: randomUUID(),
      profileId: plan.id,
      printerId: "trident-r2",
      material: "PLA",
      status: "completed",
      at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
    });

    const integrations = integrationPort({
      "moonraker-trident": { state: "printing", filename: "plate_ldo.gcode", progress: 42 },
    });
    const data = JSON.parse(
      (await invokeAssistantTool("get_farm_status", {}, { repo, integrations })).content,
    );

    const trident = data.printers.find((p: { id: string }) => p.id === "trident-r2");
    expect(trident.state).toBe("printing");
    expect(trident.active_job).toBe("plate_ldo.gcode");
    expect(trident.progress).toBe(42);
    expect(trident.idle_since).toBeNull();
  });

  it("get_farm_status flags a printer whose host reports a filament runout", async () => {
    saveFleet(repo, [machine("coreone1", "CoreOne1", "prusalink-coreone")]);

    const integrations = integrationPort({
      "prusalink-coreone": { state: "paused", message: "Filament runout detected" },
    });
    const data = JSON.parse(
      (await invokeAssistantTool("get_farm_status", {}, { repo, integrations })).content,
    );

    const coreone = data.printers.find((p: { id: string }) => p.id === "coreone1");
    expect(coreone.needs_filament_swap).toBe(true);
    expect(coreone.filament_swap_reason).toMatch(/reports filament runout/);

    // The farm-level roll-up names the machine so the digest can say
    // "CoreOne1 needs filament swap" without re-deriving it.
    expect(data.needs_filament_swap).toEqual([
      { id: "coreone1", name: "CoreOne1", reason: coreone.filament_swap_reason },
    ]);
  });

  it("get_farm_status flags an empty filament slot and leaves remaining unknown", async () => {
    // Default fleet slots carry filament_color_id: null — nothing loaded.
    saveFleet(repo, [machine("coreone1", "CoreOne1", null)]);

    const data = JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content);
    const coreone = data.printers.find((p: { id: string }) => p.id === "coreone1");

    expect(coreone.needs_filament_swap).toBe(true);
    expect(coreone.filament_swap_reason).toMatch(/no filament loaded in slot 1/);
    expect(coreone.filament_slots).toHaveLength(1);
    expect(coreone.filament_slots[0].empty).toBe(true);
    // Unknown, not 0 — nothing is loaded, so there is no inventory figure.
    expect(coreone.filament_remaining_g).toBeNull();
  });

  it("get_farm_status does not flag a swap for a non-Spoolman (catalog) filament", async () => {
    // A catalog colour id is a colour choice with no inventory behind it;
    // treating it as 0 g would flag every such printer every morning.
    const m = machine("trident-r2", "Trident R2 LDO", null);
    m.loaded_filaments = [
      { slot: 1, filament_color_id: "catalog:prusament-galaxy-black", label: "Galaxy Black" },
    ];
    saveFleet(repo, [m]);

    const data = JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content);
    const trident = data.printers.find((p: { id: string }) => p.id === "trident-r2");

    expect(trident.needs_filament_swap).toBe(false);
    expect(trident.filament_remaining_g).toBeNull();
    expect(data.needs_filament_swap).toEqual([]);
  });

  it("get_farm_status survives a printer host that throws, reporting it offline", async () => {
    saveFleet(repo, [machine("prusa-xl", "Prusa XL", "moonraker-xl")]);
    const integrations = integrationPort({}); // every getStatus throws

    const data = JSON.parse(
      (await invokeAssistantTool("get_farm_status", {}, { repo, integrations })).content,
    );
    const xl = data.printers.find((p: { id: string }) => p.id === "prusa-xl");
    expect(xl.state).toBe("offline");
    expect(data.offline).toBe(1);
  });

  describe("filament remaining per spool/printer (Spoolman-backed)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * Register a Spoolman integration and stub the HTTP layer so /spool returns
     * `spools`. This is the real code path get_farm_status takes for filament
     * inventory — buildSpoolLookup -> listSpoolmanSpools -> fetch.
     */
    function withSpoolman(spools: Array<Record<string, unknown>>): string {
      const port = createIntegrationPort({
        repo,
        getAdapter: (type) => (type === "spoolman" ? spoolmanAdapter : undefined),
      });
      const created = port.create({
        type: "spoolman",
        name: "Workshop",
        config: { base_url: "http://127.0.0.1:7912" },
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          if (String(url).includes("/spool")) {
            return new Response(JSON.stringify(spools), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      );

      return created.id;
    }

    it("reports grams remaining per slot, the spool ids behind it, and the printer total", async () => {
      const integrationId = withSpoolman([
        { id: 11, filament_id: 7, remaining_weight: 480 },
        { id: 12, filament_id: 7, remaining_weight: 310 },
        { id: 13, filament_id: 8, remaining_weight: 640 },
      ]);

      const m = machine("trident-r2", "Trident R2 LDO", null);
      m.max_filament_slots = 2;
      m.loaded_filaments = [
        { slot: 1, filament_color_id: `spoolman:${integrationId}:filament:7`, label: "LDO Black" },
        { slot: 2, filament_color_id: `spoolman:${integrationId}:filament:8`, label: "PETG" },
      ];
      saveFleet(repo, [m]);

      const data = JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content);
      const trident = data.printers.find((p: { id: string }) => p.id === "trident-r2");

      const slot1 = trident.filament_slots.find((s: { slot: number }) => s.slot === 1);
      expect(slot1.remaining_g).toBe(790); // 480 + 310 across both spools
      expect(slot1.spool_ids).toEqual([11, 12]);
      expect(slot1.low).toBe(false);

      const slot2 = trident.filament_slots.find((s: { slot: number }) => s.slot === 2);
      expect(slot2.remaining_g).toBe(640);
      expect(slot2.spool_ids).toEqual([13]);

      expect(trident.filament_remaining_g).toBe(1430);
      expect(trident.needs_filament_swap).toBe(false);
    });

    it("flags a printer whose spool is below the low-filament threshold", async () => {
      const integrationId = withSpoolman([{ id: 21, filament_id: 7, remaining_weight: 45 }]);

      const m = machine("coreone1", "CoreOne1", null);
      m.loaded_filaments = [
        { slot: 1, filament_color_id: `spoolman:${integrationId}:filament:7`, label: "LDO Black" },
      ];
      saveFleet(repo, [m]);

      const data = JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content);
      const coreone = data.printers.find((p: { id: string }) => p.id === "coreone1");

      expect(coreone.filament_remaining_g).toBe(45);
      expect(coreone.needs_filament_swap).toBe(true);
      expect(coreone.filament_swap_reason).toMatch(/slot 1 is low/);
      expect(data.needs_filament_swap.map((p: { name: string }) => p.name)).toEqual(["CoreOne1"]);
    });

    it("flags a filament Spoolman knows about but has no spools left of as 0 g", async () => {
      // Spoolman answered, and the answer is "no stock" — genuinely 0, unlike an
      // unreachable Spoolman, which must stay unknown.
      const integrationId = withSpoolman([{ id: 31, filament_id: 99, remaining_weight: 800 }]);

      const m = machine("coreone1", "CoreOne1", null);
      m.loaded_filaments = [
        { slot: 1, filament_color_id: `spoolman:${integrationId}:filament:7`, label: "LDO Black" },
      ];
      saveFleet(repo, [m]);

      const data = JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content);
      const coreone = data.printers.find((p: { id: string }) => p.id === "coreone1");

      expect(coreone.filament_remaining_g).toBe(0);
      expect(coreone.needs_filament_swap).toBe(true);
      expect(coreone.filament_swap_reason).toMatch(/out of filament/);
    });

    it("reports remaining as unknown, and raises no false alarm, when Spoolman is unreachable", async () => {
      const port = createIntegrationPort({
        repo,
        getAdapter: (type) => (type === "spoolman" ? spoolmanAdapter : undefined),
      });
      const created = port.create({
        type: "spoolman",
        name: "Workshop",
        config: { base_url: "http://127.0.0.1:7912" },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      );

      const m = machine("trident-r2", "Trident R2 LDO", null);
      m.loaded_filaments = [
        { slot: 1, filament_color_id: `spoolman:${created.id}:filament:7`, label: "LDO Black" },
      ];
      saveFleet(repo, [m]);

      const data = JSON.parse((await invokeAssistantTool("get_farm_status", {}, { repo })).content);
      const trident = data.printers.find((p: { id: string }) => p.id === "trident-r2");

      // Unknown, NOT 0 — a Spoolman outage must not page the operator about
      // every printer in the farm every morning.
      expect(trident.filament_remaining_g).toBeNull();
      expect(trident.filament_slots[0].remaining_g).toBeNull();
      expect(trident.needs_filament_swap).toBe(false);
      expect(data.needs_filament_swap).toEqual([]);
    });
  });
});

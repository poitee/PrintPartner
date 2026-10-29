import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrinterCheckoffLink, PrinterHostStatus } from "@print-partner/contracts";
import type { PrinterMachine } from "@print-partner/domain";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import type { IntegrationPort } from "../integrations/store.js";
import { saveFleet } from "../services/printer-fleet.js";
import { saveUnattributedPrint } from "../services/unattributed-print-store.js";
import { idleForLabel } from "../services/farm-filament.js";
import { invokeAssistantTool } from "./tools.js";

// GRE-1002: print stats count prints seen on printers, and farm status reports
// one honest state and one name per printer. The fleet below mirrors the shop
// data from the ticket: 8 printers (2 idle, 5 complete, the Bambu H2D with no
// host link) and 16 unattributed prints (8 Trident, 8 Redoubt).

const BAMBU_ID = "printer-862c7a57-5";

function machine(id: string, name: string, integrationId: string | null): PrinterMachine {
  return {
    id, name, model: name, bed_width_mm: 250, bed_depth_mm: 250, bed_height_mm: 250, margin_mm: 4,
    max_filament_slots: 1, loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
    integration_id: integrationId,
  };
}

const fleet = [
  machine("trident", "Trident", "host-trident"),
  machine("redoubt", "Redoubt", "host-redoubt"),
  machine("voron-0", "Voron 0", "host-voron-0"),
  machine("mk4", "MK4", "host-mk4"),
  machine("mini", "Mini", "host-mini"),
  machine("prusa-xl", "Prusa XL", "host-xl"),
  machine("coreone", "CoreOne", "host-coreone"),
  machine(BAMBU_ID, "Bambu H2D", null),
];

const shopStatuses: Record<string, PrinterHostStatus> = {
  "host-trident": { state: "complete" },
  "host-redoubt": { state: "complete" },
  "host-voron-0": { state: "complete" },
  "host-mk4": { state: "complete" },
  "host-mini": { state: "complete" },
  "host-xl": { state: "idle" },
  "host-coreone": { state: "idle" },
};

/** Read-only port: getStatus only, throwing for hosts it does not know. */
function integrationPort(statuses: Record<string, PrinterHostStatus>): IntegrationPort {
  return {
    getStatus: vi.fn(async (id: string) => {
      const s = statuses[id];
      if (!s) throw new Error("ECONNREFUSED");
      return s;
    }),
  } as unknown as IntegrationPort;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

describe("GRE-1002 farm and print stats you can trust", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-gre-1002-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedShop(): void {
    saveFleet(repo, fleet);
    // 16 completed prints attached to no plan, 8 per printer, 17 to 46 days ago.
    for (let i = 0; i < 16; i += 1) {
      const trident = i % 2 === 0;
      saveUnattributedPrint(repo, {
        id: randomUUID(),
        integration_id: trident ? "host-trident" : "host-redoubt",
        printer_id: trident ? "trident" : "redoubt",
        host_name: trident ? "Trident" : "Redoubt",
        filename: `plate-${i}.gcode`,
        completed_at: daysAgo(17 + i * 2),
        gcode_objects: [],
        candidates: [],
      });
    }
    // One Plan-attached print on the Bambu, stored under the host's other name.
    const plan = repo.createProfile("Bambu run");
    const link: PrinterCheckoffLink = {
      id: randomUUID(), profile_id: plan.id, integration_id: "bambu-host", printer_id: BAMBU_ID,
      host_name: "Bambu X2D", filename: "bambu.gcode", units: [], state: "awaiting_verify",
      host_outcome: "success", saw_active: true, created_at: daysAgo(5), completed_at: daysAgo(5),
    };
    repo.setSetting("printer.checkoff_links", JSON.stringify([link]));
    // A print_jobs row so Prusa XL has a real last-activity time; CoreOne has none.
    repo.insertPrintJob({
      id: randomUUID(), profileId: plan.id, printerId: "prusa-xl", material: "PLA", status: "completed",
      at: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    });
  }

  async function call(name: string, input: Record<string, unknown>, integrations?: IntegrationPort) {
    return JSON.parse((await invokeAssistantTool(name, input, { repo, integrations })).content);
  }

  it("1-2: 1440h stats count prints seen per printer, apart from plates sent", async () => {
    seedShop();
    const stats = await call("get_print_stats", { hours: 1440 });
    const seen = stats.prints_seen_on_printers;

    expect(stats.plates_sent).toBe(1); // the Prusa XL print_jobs row; prints seen are counted apart
    expect(seen.total).toBeGreaterThanOrEqual(16);
    expect(seen.total).toBe(17);
    expect(seen.attached_to_plan + seen.not_attached_to_plan).toBe(seen.total);
    expect(seen.not_attached_to_plan).toBe(16);
    expect(seen.attached_to_plan).toBe(1);
    const byId = Object.fromEntries(seen.by_printer.map((r: { printer_id: string }) => [r.printer_id, r]));
    expect(byId.trident.seen).toBeGreaterThanOrEqual(8);
    expect(byId.redoubt.seen).toBeGreaterThanOrEqual(8);
    expect(byId.trident).toMatchObject({ printer_name: "Trident", completed: 8, failed: 0, cancelled: 0 });
    expect(stats.empty_window).toBeUndefined();
  });

  it("2: failed and cancelled checkoff prints count as seen; still-watching ones do not", async () => {
    saveFleet(repo, fleet);
    const base = {
      profile_id: 1, integration_id: "host-mk4", printer_id: "mk4", host_name: "MK4", filename: "x.gcode",
      units: [], saw_active: true, created_at: daysAgo(1),
    };
    repo.setSetting("printer.checkoff_links", JSON.stringify([
      { ...base, id: "a", state: "host_failed", host_outcome: "failed" },
      { ...base, id: "b", state: "host_failed", host_outcome: "cancelled" },
      { ...base, id: "c", state: "watching", host_outcome: "unknown" },
    ]));
    const seen = (await call("get_print_stats", { hours: 48 })).prints_seen_on_printers;
    expect(seen.total).toBe(2);
    expect(seen.by_printer).toEqual([
      { printer_id: "mk4", printer_name: "MK4", seen: 2, completed: 0, failed: 1, cancelled: 1 },
    ]);
  });

  it("3-4: farm buckets sum to printer count; the Bambu is not connected with a reason", async () => {
    seedShop();
    const farm = await call("get_farm_status", {}, integrationPort(shopStatuses));

    expect(farm.printer_count).toBe(8);
    expect(farm.state_counts).toEqual({
      idle: 2, printing: 0, paused: 0, complete: 5, error: 0, offline: 0, not_connected: 1,
    });
    const total = Object.values(farm.state_counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(farm.printer_count);

    const bambu = farm.printers.find((p: { id: string }) => p.id === BAMBU_ID);
    expect(bambu.state).toBe("not_connected");
    expect(bambu.not_connected_reason).toBe("no printer host linked");
  });

  it("5: a linked host that cannot be reached is offline", async () => {
    saveFleet(repo, [machine("trident", "Trident", "host-trident")]);
    const farm = await call("get_farm_status", {}, integrationPort({}));
    expect(farm.printers[0]).toMatchObject({ state: "offline", not_connected_reason: null });
    expect(farm.state_counts.offline).toBe(1);
    expect(farm.state_counts.not_connected).toBe(0);
  });

  it("6: each idle printer shows an idle duration or the word unknown", async () => {
    seedShop();
    const farm = await call("get_farm_status", {}, integrationPort(shopStatuses));
    const byId = Object.fromEntries(farm.printers.map((p: { id: string }) => [p.id, p]));

    expect(byId["prusa-xl"].idle_for).toMatch(/^3h \d+m$/);
    expect(byId.coreone.idle_since).toBeNull();
    expect(byId.coreone.idle_for).toBe("unknown");
    for (const p of farm.printers) {
      if (p.state === "idle") expect(p.idle_for).toMatch(/^(unknown|\d+(d|h|m)( \d+(h|m))?)$/);
      else expect(p.idle_for).toBeNull();
    }
  });

  it("6: idle_for formats days, hours and minutes", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(idleForLabel(null, now)).toBe("unknown");
    expect(idleForLabel("not a date", now)).toBe("unknown");
    expect(idleForLabel("2026-10-29T11:48:00Z", now)).toBe("12m");
    expect(idleForLabel("2026-10-29T08:48:00Z", now)).toBe("3h 12m");
    expect(idleForLabel("2026-10-27T09:00:00Z", now)).toBe("2d 3h");
  });

  it("7: one printer id has one name in farm status, stats and printer checkoff", async () => {
    seedShop();
    const farm = await call("get_farm_status", {}, integrationPort(shopStatuses));
    const stats = await call("get_print_stats", { hours: 1440 });
    const checkoff = await call("get_printer_checkoff", {});

    const names = new Set<string>([
      farm.printers.find((p: { id: string }) => p.id === BAMBU_ID).name,
      stats.prints_seen_on_printers.by_printer.find((r: { printer_id: string }) => r.printer_id === BAMBU_ID)
        .printer_name,
      ...checkoff.links
        .filter((l: { printer_id: string }) => l.printer_id === BAMBU_ID)
        .map((l: { host_name: string }) => l.host_name),
    ]);
    expect([...names]).toEqual(["Bambu H2D"]);
    expect(checkoff.unattributed.find((u: { printer_id: string }) => u.printer_id === "trident").host_name)
      .toBe("Trident");
  });

  it("8: an empty window says so in words and names the window start", async () => {
    const stats = await call("get_print_stats", { hours: 1440 });
    expect(stats.prints_seen_on_printers).toEqual({
      total: 0, attached_to_plan: 0, not_attached_to_plan: 0, by_printer: [],
    });
    expect(stats.empty_window).toBe(`No plates sent and no prints seen on printers since ${stats.since}.`);
  });

  it("9: reading stats, farm status and checkoff writes nothing", async () => {
    seedShop();
    const keys = ["printer.checkoff_links", "printer.unattributed_prints", "printer.fleet"];
    const before = keys.map((k) => repo.getSetting(k));
    const setSetting = vi.spyOn(repo, "setSetting");
    const port = integrationPort(shopStatuses);

    await call("get_farm_status", {}, port);
    await call("get_print_stats", { hours: 1440 });
    await call("get_printer_checkoff", {});

    expect(setSetting).not.toHaveBeenCalled();
    expect(keys.map((k) => repo.getSetting(k))).toEqual(before);
    expect(Object.keys(port)).toEqual(["getStatus"]);
  });
});

/**
 * Digest fixture capture: invokes the REAL get_farm_status / get_print_stats
 * assistant tools against seeded temp DBs and writes their payloads to JSON.
 *
 * The digest formatter script is then run over those files, so the digest
 * wording is validated against actual tool output rather than a hand-written
 * guess at the payload shape.
 *
 * Usage: npx tsx capture-digest-fixtures.ts <outDir>
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getDb, SqliteDatabase, type DrizzleDb } from "./src/db/client.js";
import { backfillAcceptedPlanRevisions } from "./src/db/accepted-plan-revisions.js";
import { backfillCurrentRequiredUnitSets } from "./src/db/required-units.js";
import { AppRepository } from "./src/db/repository.js";
import * as schema from "./src/db/schema.js";
import { invokeAssistantTool } from "./src/assistant/tools.js";
import { saveFleet } from "./src/services/printer-fleet.js";
import type { IntegrationPort } from "./src/integrations/store.js";
import type { PrinterHostStatus } from "@print-partner/contracts";
import type { PrinterMachine } from "@print-partner/domain";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: tsx capture-digest-fixtures.ts <outDir>");
mkdirSync(outDir, { recursive: true });

function machine(id: string, name: string, integrationId: string | null): PrinterMachine {
  return {
    id,
    name,
    bed_width_mm: 250,
    bed_depth_mm: 250,
    bed_height_mm: 250,
    margin_mm: 4,
    max_filament_slots: 1,
    loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
    integration_id: integrationId,
  };
}

function port(statuses: Record<string, PrinterHostStatus>): IntegrationPort {
  return {
    getStatus: async (id: string) => {
      const s = statuses[id];
      if (!s) throw new Error("offline");
      return s;
    },
  } as unknown as IntegrationPort;
}

/** remaining_units is derived from included parts minus printed progress, so
 *  seed N unprinted single-unit parts to get remaining_units === N. */
function seedRemainingUnits(db: DrizzleDb, profileId: number, units: number): void {
  for (let i = 0; i < units; i++) {
    db.insert(schema.parts)
      .values({
        tenantId: "default",
        profileId,
        matchKey: `part-${i}.stl`,
        relativePath: `part-${i}.stl`,
        filename: `part-${i}.stl`,
        quantityEffective: 1,
        included: true,
      })
      .returning()
      .get();
  }
}

function seedAcceptedState(sqlite: SqliteDatabase): void {
  const database = new Database(sqlite.dbPath);
  let token = 1;
  try {
    backfillAcceptedPlanRevisions(database, "2026-08-21T12:00:00.000Z");
    backfillCurrentRequiredUnitSets(database, {
      now: () => "2026-08-21T12:01:00.000Z",
      tokenFactory: () => `ppu_${(token++).toString(16).padStart(32, "0")}`,
    });
  } finally {
    database.close();
  }
}

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

type Scenario = {
  name: string;
  note: string;
  fleet: PrinterMachine[];
  statuses: Record<string, PrinterHostStatus>;
  jobs: Array<{ printerId: string; status: string; hoursAgo: number; doneHoursAgo?: number }>;
  plan?: { name: string; units: number };
};

const scenarios: Scenario[] = [
  {
    name: "spec-example",
    note: "overnight prints + live plan + idle machine + a machine needing filament",
    fleet: [
      machine("trident-r2", "Trident R2 LDO", "moonraker-trident"),
      machine("prusa-xl", "Prusa XL", "moonraker-xl"),
      machine("coreone1", "CoreOne1", null),
    ],
    statuses: {
      "moonraker-trident": { state: "printing", filename: "plate_ldo.gcode", progress: 42 },
      "moonraker-xl": { state: "idle" },
    },
    jobs: [
      { printerId: "prusa-xl", status: "completed", hoursAgo: 6, doneHoursAgo: 5 },
      { printerId: "trident-r2", status: "completed", hoursAgo: 5, doneHoursAgo: 4 },
      { printerId: "trident-r2", status: "completed", hoursAgo: 3, doneHoursAgo: 2 },
    ],
    plan: { name: "Trident R2 LDO", units: 189 },
  },
  {
    name: "no-activity",
    note: "empty farm, nothing ran — greeting only",
    fleet: [],
    statuses: {},
    jobs: [],
  },
  {
    name: "all-idle",
    note: "every printer idle, no overnight jobs, plan outstanding",
    fleet: [machine("a", "Redoubt", "int-a"), machine("b", "Vertigo", "int-b")],
    statuses: { "int-a": { state: "idle" }, "int-b": { state: "idle" } },
    jobs: [],
    plan: { name: "Backlog Kit", units: 42 },
  },
  {
    name: "with-failures",
    note: "a failed overnight run must not inflate the completed count",
    fleet: [machine("t", "Trident", "int-t")],
    statuses: { "int-t": { state: "idle" } },
    jobs: [
      { printerId: "t", status: "completed", hoursAgo: 6, doneHoursAgo: 5 },
      { printerId: "t", status: "failed", hoursAgo: 4, doneHoursAgo: 3 },
    ],
    plan: { name: "Trident R2 LDO", units: 7 },
  },
  {
    // The worst case for the digest: every overnight plate was attempted and
    // every one of them failed. plates_completed is 0, so a digest that only
    // reads plates_completed says "No plates printed overnight" — indistinguishable
    // from a farm that simply sat idle. See kanban t_9e139737.
    name: "all-failed",
    note: "every overnight plate failed — the digest must not read as a quiet night",
    fleet: [machine("t", "Trident", "int-t")],
    statuses: { "int-t": { state: "idle" } },
    jobs: [
      { printerId: "t", status: "failed", hoursAgo: 7, doneHoursAgo: 6 },
      { printerId: "t", status: "failed", hoursAgo: 6, doneHoursAgo: 5 },
      { printerId: "t", status: "failed", hoursAgo: 5, doneHoursAgo: 4 },
    ],
    plan: { name: "Trident R2 LDO", units: 12 },
  },
  {
    name: "offline-printer",
    note: "an unreachable host must read as offline, not as idle-since-never",
    fleet: [machine("x", "Redoubt", "int-missing")],
    statuses: {},
    jobs: [],
  },
  {
    // A genuine, actionable swap: the printer host itself reports a runout.
    // This is the case the digest MUST name, as distinct from the "slot has no
    // filament mapped in Spoolman" bookkeeping gap that affects every machine.
    name: "real-filament-runout",
    note: "host reports a filament runout — an actionable swap the digest must name",
    fleet: [machine("c1", "CoreOne1", "int-c1"), machine("t", "Trident", "int-t")],
    statuses: {
      "int-c1": { state: "paused", message: "Filament runout detected - load filament" },
      "int-t": { state: "printing", filename: "plate.gcode" },
    },
    jobs: [],
  },
];

for (const scenario of scenarios) {
  const dir = mkdtempSync(join(tmpdir(), `pp-digest-${scenario.name}-`));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  try {
    const db = getDb(sqlite);
    const repo = new AppRepository(db, undefined, sqlite.reposDir);

    saveFleet(repo, scenario.fleet);

    // print_jobs.profile_id is NOT NULL, so every scenario needs a plan even
    // when the digest is not meant to report remaining units for it.
    let profileId: number;
    if (scenario.plan) {
      const plan = repo.createProfile(scenario.plan.name);
      seedRemainingUnits(db, plan.id, scenario.plan.units);
      seedAcceptedState(sqlite);
      profileId = plan.id;
    } else {
      profileId = repo.createProfile(`${scenario.name} scratch plan`).id;
    }

    for (const [i, job] of scenario.jobs.entries()) {
      repo.insertPrintJob({
        id: `${scenario.name}-job-${i}`,
        profileId,
        at: iso(job.hoursAgo),
        completedAt: job.doneHoursAgo != null ? iso(job.doneHoursAgo) : null,
        printerId: job.printerId,
        status: job.status,
        filamentConsumedG: 120,
      } as never);
    }

    const integrations = port(scenario.statuses);
    const farm = await invokeAssistantTool("get_farm_status", {}, { repo, integrations } as never);
    const stats = await invokeAssistantTool(
      "get_print_stats",
      { hours: 8 },
      { repo, integrations } as never,
    );

    writeFileSync(join(outDir, `${scenario.name}.farm.json`), farm.content);
    writeFileSync(join(outDir, `${scenario.name}.stats.json`), stats.content);
    console.log(`captured ${scenario.name} — ${scenario.note}`);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("fixtures written to", outDir);

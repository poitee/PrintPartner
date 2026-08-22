import { acceptPlanForTest, editAcceptedPartsForTest } from "../test/accept-plan.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "./client.js";
import { AppRepository, type SchemaTables } from "./repository.js";
import * as pgSchema from "./schema-pg.js";
import {
  registerPostgresSyncQuery,
  unregisterPostgresSyncQuery,
} from "./sync-db-bridge.js";
import {
  createPrinterCheckoffLink,
  getPrinterCheckoffLink,
  loadPrinterCheckoffLinks,
} from "../services/printer-checkoff-store.js";
import { reconcilePrinterCheckoff } from "../services/printer-checkoff.js";
import { parseRequiredUnitToken } from "../services/required-units.js";
import { acceptedPlanBasis } from "./accepted-plan-progress.js";
import {
  claimUnattributedPrint,
  createUnattributedPrint,
  listUnattributedPrints,
  saveUnattributedPrint,
} from "../services/unattributed-print-store.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pp-printer-attribution-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
  const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b" });
  const repoPath = join(dir, "repos", String(source.id));
  mkdirSync(join(repoPath, "parts"), { recursive: true });
  writeFileSync(join(repoPath, "parts", "bracket.stl"), "solid");
  repo.updateSource(source.id, { local_path: repoPath });
  repo.updateImportRules(source.id, ["parts/"]);
  const plan = repo.createProfile("Accepted printer", source.id);
  acceptPlanForTest(repo, plan.id);
  const priorBracket = repo.listParts(plan.id).parts.find((part) => part.filename === "bracket.stl")!;
  const remapped = editAcceptedPartsForTest(repo, plan.id, [{
    projectionPartId: priorBracket.id,
    quantityOverride: 2,
  }]);
  const bracket = repo.getPartRow(remapped.get(priorBracket.id)!)!;
  const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
  if (accepted.kind !== "ready") throw new Error("accepted fixture is unavailable");
  const acceptedPart = accepted.snapshot.parts.find(
    (part) => part.projectionPartId === bracket.id,
  )!;
  const raw = (sqlite as unknown as { sqlite: Database.Database }).sqlite;
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { repo, plan, bracket, acceptedPart, accepted: accepted.snapshot, raw };
}

function setupUninitialized() {
  const dir = mkdtempSync(join(tmpdir(), "pp-printer-attribution-uninitialized-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
  const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b" });
  const repoPath = join(dir, "repos", String(source.id));
  mkdirSync(join(repoPath, "parts"), { recursive: true });
  writeFileSync(join(repoPath, "parts", "bracket.stl"), "solid");
  repo.updateSource(source.id, { local_path: repoPath });
  repo.updateImportRules(source.id, ["parts/"]);
  const plan = repo.createProfile("Uninitialized attribution", source.id);
  acceptPlanForTest(repo, plan.id);
  const raw = (sqlite as unknown as { sqlite: Database.Database }).sqlite;
  raw.exec(`
    DROP TRIGGER trg_plan_revision_required_units_immutable_delete;
    DROP TRIGGER trg_plan_revision_required_unit_sets_immutable_delete;
    DROP TRIGGER trg_required_units_immutable_delete;
    DELETE FROM plan_revision_required_units;
    DELETE FROM plan_revision_required_unit_sets;
    DELETE FROM required_units;
  `);
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { repo, plan };
}

describe("accepted printer attribution repository command", () => {
  it("creates a watching link from one accepted snapshot without mutable Part reads", () => {
    const { repo, plan, bracket, acceptedPart } = setup();
    const mutableParts = vi.spyOn(repo, "getProfilePartRows");
    const transaction = vi.spyOn(repo, "transaction");

    const result = repo.materializeAcceptedPrinterLink({
      kind: "create",
      profileId: plan.id,
      objectNames: [acceptedPart.units[0]!.objectName],
      fallbackFilename: "bracket.bgcode",
      link: {
        integrationId: "prusa-1",
        printerId: "core-one",
        hostName: "Core One",
        filename: "bracket.bgcode",
        started: false,
      },
    });

    expect(result).toMatchObject({
      kind: "created",
      link: { units: [{ part_id: bracket.id, unit_index: 0 }], state: "watching" },
    });
    expect(mutableParts).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), "immediate");
  });

  it("uses completion state read inside the command", () => {
    const { repo, plan, bracket, acceptedPart, accepted } = setup();
    const completed = repo.setAcceptedUnitCompletion({
      expected: acceptedPlanBasis(accepted),
      token: parseRequiredUnitToken(acceptedPart.units[0]!.token),
      completed: true,
    });
    expect(completed.kind).toBe("updated");

    const result = repo.materializeAcceptedPrinterLink({
      kind: "create",
      profileId: plan.id,
      objectNames: ["bracket.stl"],
      fallbackFilename: "bracket.bgcode",
      link: {
        integrationId: "prusa-1",
        printerId: "core-one",
        hostName: "Core One",
        filename: "bracket.bgcode",
        started: false,
      },
    });

    expect(result).toMatchObject({
      kind: "created",
      link: { units: [{ part_id: bracket.id, unit_index: 1 }] },
    });
  });

  it("does not write a link or Progress when no accepted unit matches", () => {
    const { repo, plan } = setup();
    const before = repo.getSetting("printer.checkoff_links");
    const setSetting = vi.spyOn(repo, "setSetting");

    const result = repo.materializeAcceptedPrinterLink({
      kind: "create",
      profileId: plan.id,
      objectNames: ["unknown"],
      fallbackFilename: "unknown.bgcode",
      link: {
        integrationId: "prusa-1",
        printerId: "core-one",
        hostName: "Core One",
        filename: "unknown.bgcode",
        started: false,
      },
    });

    expect(result).toEqual({ kind: "no_match" });
    expect(repo.getSetting("printer.checkoff_links")).toBe(before);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("does not write for empty, dirty, or uninitialized accepted state", () => {
    const cases: Array<{
      expected: "empty" | "compatibility_dirty";
      arrange: (fixture: ReturnType<typeof setup>) => number;
    }> = [
      {
        expected: "empty",
        arrange: ({ repo }) => repo.createProfile("Empty attribution").id,
      },
      {
        expected: "compatibility_dirty",
        arrange: ({ plan, bracket, raw }) => {
          raw.prepare("UPDATE parts SET notes = 'dirty' WHERE id = ?").run(bracket.id);
          return plan.id;
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = setup();
      const profileId = testCase.arrange(fixture);
      expect(fixture.repo.readAcceptedPlanOperationalSnapshot(profileId).kind).toBe(
        testCase.expected,
      );
      const setSetting = vi.spyOn(fixture.repo, "setSetting");
      const result = fixture.repo.materializeAcceptedPrinterLink({
        kind: "create",
        profileId,
        objectNames: ["bracket.stl"],
        fallbackFilename: "bracket.bgcode",
        link: {
          integrationId: "prusa-1",
          printerId: "core-one",
          hostName: "Core One",
          filename: "bracket.bgcode",
          started: false,
        },
      });

      expect(result).toEqual(
        testCase.expected === "empty"
          ? { kind: "empty" }
          : { kind: "accepted_state_unavailable", reason: testCase.expected },
      );
      expect(setSetting).not.toHaveBeenCalled();
    }

    const uninitialized = setupUninitialized();
    expect(uninitialized.repo.readAcceptedPlanOperationalSnapshot(uninitialized.plan.id)).toEqual({
      kind: "uninitialized",
    });
    const setSetting = vi.spyOn(uninitialized.repo, "setSetting");
    expect(
      uninitialized.repo.materializeAcceptedPrinterLink({
        kind: "create",
        profileId: uninitialized.plan.id,
        objectNames: ["bracket.stl"],
        fallbackFilename: "bracket.bgcode",
        link: {
          integrationId: "prusa-1",
          printerId: "core-one",
          hostName: "Core One",
          filename: "bracket.bgcode",
          started: false,
        },
      }),
    ).toEqual({ kind: "accepted_state_unavailable", reason: "uninitialized" });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("durably repairs an exact empty awaiting link", () => {
    const { repo, plan, bracket, acceptedPart } = setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [],
      unlabeled_names: [acceptedPart.units[0]!.objectName],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });
    const awaiting = getPrinterCheckoffLink(repo, link.id)!;

    const result = repo.materializeAcceptedPrinterLink({
      kind: "repair",
      expectedLink: awaiting,
    });

    expect(result).toMatchObject({
      kind: "repaired",
      link: { id: link.id, units: [{ part_id: bracket.id, unit_index: 0 }] },
    });
    expect(getPrinterCheckoffLink(repo, link.id)?.units).toEqual([
      { part_id: bracket.id, unit_index: 0 },
    ]);
  });

  it("claims one exact open print and commits an awaiting link, history, and binding", () => {
    const { repo, plan, bracket, acceptedPart } = setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      [acceptedPart.units[0]!.objectName],
      [],
    );
    const duplicate = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      ["legacy duplicate"],
      [],
    );
    saveUnattributedPrint(repo, print);
    saveUnattributedPrint(repo, duplicate);

    const result = repo.materializeAcceptedPrinterLink({
      kind: "claim",
      profileId: plan.id,
      expectedPrint: print,
    });

    expect(result).toMatchObject({
      kind: "claimed",
      link: {
        state: "awaiting_verify",
        units: [{ part_id: bracket.id, unit_index: 0 }],
        completed_at: print.completed_at,
        saw_active: true,
      },
    });
    expect(listUnattributedPrints(repo)).toEqual([
      expect.objectContaining({ id: print.id, claimed_profile_id: plan.id }),
      expect.objectContaining({ id: duplicate.id, claimed_profile_id: plan.id }),
    ]);
    expect(JSON.parse(repo.getSetting("printer.plan_bindings") ?? "[]")).toEqual([
      expect.objectContaining({ integration_id: "prusa-1", profile_id: plan.id }),
    ]);
  });

  it("detects a concurrently claimed expected print without partial state", () => {
    const { repo, plan, acceptedPart } = setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      [acceptedPart.units[0]!.objectName],
      [],
    );
    saveUnattributedPrint(repo, print);
    claimUnattributedPrint(repo, print.id, plan.id);
    const beforePrints = repo.getSetting("printer.unattributed_prints");

    expect(
      repo.materializeAcceptedPrinterLink({
        kind: "claim",
        profileId: plan.id,
        expectedPrint: print,
      }),
    ).toEqual({ kind: "print_changed" });
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
    expect(repo.getSetting("printer.unattributed_prints")).toBe(beforePrints);
    expect(repo.getSetting("printer.plan_bindings")).toBeNull();
  });

  it("returns already_linked without claiming history or changing the binding", () => {
    const { repo, plan, bracket, acceptedPart } = setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      [acceptedPart.units[0]!.objectName],
      [],
    );
    saveUnattributedPrint(repo, print);
    createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    });
    const beforeLinks = repo.getSetting("printer.checkoff_links");
    const beforePrints = repo.getSetting("printer.unattributed_prints");

    expect(
      repo.materializeAcceptedPrinterLink({
        kind: "claim",
        profileId: plan.id,
        expectedPrint: print,
      }),
    ).toEqual({ kind: "already_linked" });
    expect(repo.getSetting("printer.checkoff_links")).toBe(beforeLinks);
    expect(repo.getSetting("printer.unattributed_prints")).toBe(beforePrints);
    expect(repo.getSetting("printer.plan_bindings")).toBeNull();
  });

  it.each([
    ["link transition", "printer.checkoff_links", 2],
    ["history setting", "printer.unattributed_prints", 1],
    ["binding setting", "printer.plan_bindings", 1],
  ])("rolls back every claim write after an injected %s failure", (_label, key, failAt) => {
    const { repo, plan, acceptedPart } = setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      [acceptedPart.units[0]!.objectName],
      [],
    );
    saveUnattributedPrint(repo, print);
    repo.setSetting(
      "printer.plan_bindings",
      JSON.stringify([{ integration_id: "other", profile_id: null, updated_at: "before" }]),
    );
    const before = {
      links: repo.getSetting("printer.checkoff_links"),
      prints: repo.getSetting("printer.unattributed_prints"),
      bindings: repo.getSetting("printer.plan_bindings"),
    };
    const originalSetSetting = repo.setSetting.bind(repo);
    let calls = 0;
    vi.spyOn(repo, "setSetting").mockImplementation((settingKey, value) => {
      if (settingKey === key && ++calls === failAt) throw new Error("injected claim failure");
      originalSetSetting(settingKey, value);
    });

    expect(() =>
      repo.materializeAcceptedPrinterLink({
        kind: "claim",
        profileId: plan.id,
        expectedPrint: print,
      }),
    ).toThrow("injected claim failure");
    expect(repo.getSetting("printer.checkoff_links")).toBe(before.links);
    expect(repo.getSetting("printer.unattributed_prints")).toBe(before.prints);
    expect(repo.getSetting("printer.plan_bindings")).toBe(before.bindings);
  });

  it("rolls back link and history writes when stored bindings are malformed", () => {
    const { repo, plan, acceptedPart } = setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      [acceptedPart.units[0]!.objectName],
      [],
    );
    saveUnattributedPrint(repo, print);
    repo.setSetting("printer.plan_bindings", "{private malformed binding");
    const beforePrints = repo.getSetting("printer.unattributed_prints");

    expect(() =>
      repo.materializeAcceptedPrinterLink({
        kind: "claim",
        profileId: plan.id,
        expectedPrint: print,
      }),
    ).toThrow("Printer Plan bindings are corrupt");
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
    expect(repo.getSetting("printer.unattributed_prints")).toBe(beforePrints);
    expect(repo.getSetting("printer.plan_bindings")).toBe("{private malformed binding");
  });

  it("refuses PostgreSQL before any query", () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerPostgresSyncQuery(postgres, ({ sql }) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    });
    const repo = new AppRepository(
      postgres,
      "default",
      "/tmp/unused-printer-attribution",
      pgSchema as unknown as SchemaTables,
    );
    try {
      expect(
        repo.materializeAcceptedPrinterLink({
          kind: "create",
          profileId: 1,
          objectNames: ["bracket.stl"],
          fallbackFilename: "bracket.gcode",
          link: {
            integrationId: "prusa-1",
            printerId: "core-one",
            hostName: "Core One",
            filename: "bracket.gcode",
            started: false,
          },
        }),
      ).toEqual({ kind: "transaction_unavailable" });
      expect(
        repo.materializeAcceptedPrinterLink({
          kind: "claim",
          profileId: 1,
          expectedPrint: createUnattributedPrint(
            "prusa-1",
            "core-one",
            "Core One",
            "bracket.gcode",
            ["bracket.stl"],
            [],
          ),
        }),
      ).toEqual({ kind: "transaction_unavailable" });
      expect(statements).toEqual([]);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });
});

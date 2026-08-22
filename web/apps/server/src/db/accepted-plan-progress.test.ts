import { acceptPlanForTest, editAcceptedPartsForTest } from "../test/accept-plan.js";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { acceptedPlanBasis, acceptedProgressSummary } from "./accepted-plan-progress.js";
import { parseRequiredUnitToken } from "../services/required-units.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(quantity = 4, included = true) {
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-progress-"));
  roots.push(root);
  const ports = createSelfHostPorts(root);
  await ports.db.connect();
  const repo = ports.repository;
  const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b" });
  const sourceRoot = join(root, "repos", String(source.id));
  mkdirSync(join(sourceRoot, "parts"), { recursive: true });
  writeFileSync(join(sourceRoot, "parts", "widget.stl"), "solid widget");
  repo.updateSource(source.id, { local_path: sourceRoot });
  repo.updateImportRules(source.id, ["parts/"]);
  const profile = repo.createProfile("Accepted progress", source.id);
  acceptPlanForTest(repo, profile.id);
  const part = repo.listParts(profile.id).parts[0];
  if (!part) throw new Error("test Part is missing");
  const remapped = editAcceptedPartsForTest(repo, profile.id, [{
    projectionPartId: part.id,
    quantityOverride: quantity,
    ...(!included ? { included: false } : {}),
  }]);

  const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
  if (accepted.kind !== "ready") throw new Error(`accepted state is ${accepted.kind}`);
  return {
    root,
    repo,
    profileId: profile.id,
    partId: remapped.get(part.id)!,
    snapshot: accepted.snapshot,
  };
}

describe("accepted Plan Progress commands", () => {
  it("updates completion and assembly by immutable token and accepted basis", async () => {
    const { repo, partId, snapshot } = await fixture();
    const expected = acceptedPlanBasis(snapshot);
    const units = snapshot.parts[0]?.units;
    if (!units) throw new Error("accepted units are missing");

    expect(
      repo.setAcceptedUnitCompletion({
        expected,
        token: parseRequiredUnitToken(units[2]!.token),
        completed: true,
      }),
    ).toEqual({
      kind: "updated",
      body: {
        part_id: partId,
        printed_count: 3,
        print_units: [true, true, true, false],
        assembled_units: [false, false, false, false],
        missing: true,
      },
    });
    expect(
      repo.setAcceptedUnitAssembly({
        expected,
        token: parseRequiredUnitToken(units[0]!.token),
        assembled: true,
      }),
    ).toMatchObject({ kind: "updated", body: { assembled_units: [true, false, false, false] } });
    expect(
      repo.setAcceptedUnitAssembly({
        expected,
        token: parseRequiredUnitToken(units[3]!.token),
        assembled: true,
      }),
    ).toMatchObject({ kind: "updated", body: { assembled_units: [true, false, false, false] } });
    expect(
      repo.setAcceptedUnitCompletion({
        expected,
        token: parseRequiredUnitToken(units[1]!.token),
        completed: false,
      }),
    ).toMatchObject({
      kind: "updated",
      body: {
        print_units: [true, false, false, false],
        assembled_units: [true, false, false, false],
      },
    });
  });

  it("rejects a stale basis and unknown token without writing", async () => {
    const { repo, profileId, snapshot } = await fixture(2);
    const expected = acceptedPlanBasis(snapshot);
    const before = repo.readAcceptedPlanOperationalSnapshot(profileId);
    const token = parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token);

    expect(
      repo.setAcceptedUnitCompletion({
        expected: { ...expected, planVersion: expected.planVersion + 1 },
        token,
        completed: true,
      }),
    ).toEqual({ kind: "stale_accepted_plan" });
    expect(
      repo.setAcceptedUnitCompletion({
        expected,
        token: parseRequiredUnitToken("ppu_ffffffffffffffffffffffffffffffff"),
        completed: true,
      }),
    ).toEqual({ kind: "unit_not_found" });
    expect(repo.readAcceptedPlanOperationalSnapshot(profileId)).toEqual(before);
  });

  it("keeps an excluded accepted Part addressable while omitting it from summary", async () => {
    const { repo, snapshot } = await fixture(1, false);
    expect(acceptedProgressSummary(snapshot)).toEqual({ totalUnits: 0, remainingUnits: 0 });
    expect(
      repo.setAcceptedUnitCompletion({
        expected: acceptedPlanBasis(snapshot),
        token: parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token),
        completed: true,
      }),
    ).toMatchObject({ kind: "updated", body: { print_units: [true] } });
  });

  it("archives only a complete accepted required-unit set", async () => {
    const { repo, snapshot } = await fixture(1);
    const expected = acceptedPlanBasis(snapshot);
    const token = parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token);

    expect(repo.archiveAcceptedPlan({ expected })).toEqual({
      kind: "remaining",
      totalUnits: 1,
      remainingUnits: 1,
    });
    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: true }).kind).toBe(
      "updated",
    );
    expect(repo.archiveAcceptedPlan({ expected })).toMatchObject({ kind: "archived" });
    expect(repo.archiveAcceptedPlan({ expected })).toMatchObject({ kind: "already_archived" });
  });

  it("rejects completion and assembly changes after archive without writing Progress", async () => {
    const { root, repo, partId, snapshot } = await fixture(1);
    const expected = acceptedPlanBasis(snapshot);
    const token = parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token);
    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: true }).kind).toBe(
      "updated",
    );
    expect(repo.archiveAcceptedPlan({ expected }).kind).toBe("archived");
    const raw = new Database(join(root, "print-partner.db"));
    const before = raw
      .prepare("SELECT completed, assembled FROM print_progress WHERE part_id = ?")
      .get(partId);

    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: false })).toEqual({
      kind: "plan_archived",
    });
    expect(repo.setAcceptedUnitAssembly({ expected, token, assembled: true })).toEqual({
      kind: "plan_archived",
    });
    expect(
      raw.prepare("SELECT completed, assembled FROM print_progress WHERE part_id = ?").get(partId),
    ).toEqual(before);
    raw.close();
  });

  it("imports printed counts atomically against one accepted basis", async () => {
    const { root, repo, profileId, partId, snapshot } = await fixture(3);
    const expected = acceptedPlanBasis(snapshot);
    const before = repo.readAcceptedPlanOperationalSnapshot(profileId);

    expect(repo.setAcceptedPrintedCounts({
      expected: { ...expected, planVersion: expected.planVersion + 1 },
      rows: [{ partId, printedCount: 2 }],
    })).toEqual({ kind: "stale_accepted_plan" });
    expect(repo.readAcceptedPlanOperationalSnapshot(profileId)).toEqual(before);

    expect(repo.setAcceptedPrintedCounts({
      expected,
      rows: [
        { partId, printedCount: 1 },
        { partId: partId + 10_000, printedCount: 1 },
      ],
    })).toEqual({ kind: "part_not_found" });
    expect(repo.readAcceptedPlanOperationalSnapshot(profileId)).toEqual(before);

    const raw = new Database(join(root, "print-partner.db"));
    raw.prepare(
      "UPDATE print_progress SET completed = CASE WHEN unit_index = 1 THEN 1 ELSE 0 END WHERE part_id = ?",
    ).run(partId);
    expect(repo.setAcceptedPrintedCounts({
      expected,
      rows: [{ partId, printedCount: 2 }],
    })).toEqual({ kind: "updated", updatedParts: 1 });
    const normalized = repo.readAcceptedPlanOperationalSnapshot(profileId);
    if (normalized.kind !== "ready") throw new Error("normalized accepted state is unavailable");
    expect(normalized.snapshot.parts[0]!.units.map((unit) => unit.completed)).toEqual([
      true,
      true,
      false,
    ]);
    raw.prepare("UPDATE print_progress SET completed = 0 WHERE part_id = ?").run(partId);
    raw.exec(`
      CREATE TRIGGER fail_second_progress_import
      BEFORE UPDATE ON print_progress
      WHEN NEW.part_id = ${partId} AND NEW.unit_index = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected progress import failure');
      END;
    `);
    expect(() => repo.setAcceptedPrintedCounts({
      expected,
      rows: [{ partId, printedCount: 3 }],
    })).toThrow("injected progress import failure");
    expect(repo.readAcceptedPlanOperationalSnapshot(profileId)).toEqual(before);
    raw.exec("DROP TRIGGER fail_second_progress_import");
    raw.close();

    expect(repo.setAcceptedPrintedCounts({
      expected,
      rows: [{ partId, printedCount: 2 }],
    })).toEqual({ kind: "updated", updatedParts: 1 });
    const updated = repo.readAcceptedPlanOperationalSnapshot(profileId);
    expect(updated.kind).toBe("ready");
    if (updated.kind !== "ready") throw new Error("updated accepted state is unavailable");
    expect(updated.snapshot.parts[0]!.units.map((unit) => unit.completed)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("waits for a concurrent archive commit and then rejects an uncheck", async () => {
    const { root, repo, profileId, partId, snapshot } = await fixture(1);
    const expected = acceptedPlanBasis(snapshot);
    const token = parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token);
    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: true }).kind).toBe(
      "updated",
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import Database from "better-sqlite3";
const database = new Database(process.argv[1]);
database.pragma("busy_timeout = 5000");
database.exec("BEGIN IMMEDIATE");
database.prepare("UPDATE build_profiles SET archived_at = ? WHERE id = ?").run("2026-08-21T14:00:00.000Z", Number(process.argv[2]));
process.stdout.write("archived\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
database.exec("COMMIT");
database.close();`,
        join(root, "print-partner.db"),
        String(profileId),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!child.stdout) throw new Error("archive barrier stdout is missing");
    await once(child.stdout, "data");

    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: false })).toEqual({
      kind: "plan_archived",
    });
    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
    const raw = new Database(join(root, "print-partner.db"), { readonly: true });
    expect(
      raw.prepare("SELECT completed FROM print_progress WHERE part_id = ?").pluck().get(partId),
    ).toBe(1);
    raw.close();
  });

  it("waits for a concurrent uncheck commit and then refuses archive", async () => {
    const { root, repo, profileId, partId, snapshot } = await fixture(1);
    const expected = acceptedPlanBasis(snapshot);
    const token = parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token);
    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: true }).kind).toBe(
      "updated",
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import Database from "better-sqlite3";
const database = new Database(process.argv[1]);
database.pragma("busy_timeout = 5000");
database.exec("BEGIN IMMEDIATE");
database.prepare("UPDATE print_progress SET completed = 0, assembled = 0 WHERE part_id = ? AND unit_index = 0").run(Number(process.argv[2]));
process.stdout.write("unchecked\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
database.exec("COMMIT");
database.close();`,
        join(root, "print-partner.db"),
        String(partId),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!child.stdout) throw new Error("uncheck barrier stdout is missing");
    await once(child.stdout, "data");

    expect(repo.archiveAcceptedPlan({ expected })).toEqual({
      kind: "remaining",
      totalUnits: 1,
      remainingUnits: 1,
    });
    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
    const raw = new Database(join(root, "print-partner.db"), { readonly: true });
    expect(
      raw.prepare("SELECT archived_at FROM build_profiles WHERE id = ?").pluck().get(profileId),
    ).toBeNull();
    raw.close();
  });

  it("fails closed on missing accepted Progress without repairing it", async () => {
    const { root, repo, partId, snapshot } = await fixture(2);
    const raw = new Database(join(root, "print-partner.db"));
    raw.prepare("DELETE FROM print_progress WHERE part_id = ? AND unit_index = 1").run(partId);
    raw.close();

    expect(() =>
      repo.setAcceptedUnitCompletion({
        expected: acceptedPlanBasis(snapshot),
        token: parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token),
        completed: true,
      }),
    ).toThrowError(/progress rows are incomplete/i);
    const after = new Database(join(root, "print-partner.db"), { readonly: true });
    expect(
      after.prepare("SELECT unit_index, completed FROM print_progress WHERE part_id = ? ORDER BY unit_index").all(partId),
    ).toEqual([{ unit_index: 0, completed: 0 }]);
    after.close();
  });

  it("ignores and preserves a legal surplus Progress row across current-unit commands", async () => {
    const { root, repo, partId, snapshot } = await fixture(1);
    const raw = new Database(join(root, "print-partner.db"));
    raw.prepare(
      `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
       VALUES ('default', ?, 7, 1, 1)`,
    ).run(partId);
    const surplus = () =>
      raw
        .prepare(
          `SELECT tenant_id, part_id, unit_index, completed, assembled
             FROM print_progress WHERE part_id = ? AND unit_index = 7`,
        )
        .get(partId);
    const before = surplus();
    const expected = acceptedPlanBasis(snapshot);
    const token = parseRequiredUnitToken(snapshot.parts[0]!.units[0]!.token);

    expect(repo.setAcceptedUnitCompletion({ expected, token, completed: true }).kind).toBe(
      "updated",
    );
    expect(repo.setAcceptedUnitAssembly({ expected, token, assembled: true }).kind).toBe(
      "updated",
    );
    expect(repo.archiveAcceptedPlan({ expected }).kind).toBe("archived");
    expect(surplus()).toEqual(before);
    raw.close();
  });

  it("rolls back a prefix update when a later accepted unit write fails", async () => {
    const { root, repo, partId, snapshot } = await fixture(3);
    const raw = new Database(join(root, "print-partner.db"));
    raw.exec(`CREATE TRIGGER fail_second_progress_update
      BEFORE UPDATE ON print_progress
      WHEN NEW.part_id = ${partId} AND NEW.unit_index = 1
      BEGIN
        SELECT RAISE(ABORT, 'private progress failure');
      END`);

    expect(() =>
      repo.setAcceptedUnitCompletion({
        expected: acceptedPlanBasis(snapshot),
        token: parseRequiredUnitToken(snapshot.parts[0]!.units[2]!.token),
        completed: true,
      }),
    ).toThrowError(/private progress failure/);
    expect(
      raw.prepare("SELECT completed FROM print_progress WHERE part_id = ? ORDER BY unit_index").all(partId),
    ).toEqual([{ completed: 0 }, { completed: 0 }, { completed: 0 }]);
    raw.close();
  });
});

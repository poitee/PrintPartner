import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { closeBundle, connectBundle, openDatabaseBundle, repositoryForTenant } from "./database.js";

const databaseUrl = process.env.GRE498_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)("uses the live Postgres bridge to serialize plan CAS and deletion across connections", async () => {
  if (!databaseUrl) throw new Error("GRE498_TEST_DATABASE_URL is required");
  const schemaName = `gre498_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set("options", `-c search_path=${schemaName}`);
  const dataDir = mkdtempSync(join(tmpdir(), "pp-gre498-pg-"));
  const bundle = openDatabaseBundle(dataDir, scoped.toString(), "saas");
  const writer = new pg.Client({ connectionString: scoped.toString() });
  const workers: ReturnType<typeof spawn>[] = [];
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    await connectBundle(bundle);
    await writer.connect();
    const repo = bundle.repository;
    const profileId = repo.createProfile("Insert before deletion").id;
    const key = `feature_toggles:plan:${profileId}`;
    const workerSource = `
      import { openDatabaseBundle, connectBundle, closeBundle } from ${JSON.stringify(new URL("./database.ts", import.meta.url).href)};
      const bundle = openDatabaseBundle(process.env.GRE498_WORKER_DIR, process.env.GRE498_WORKER_URL, "saas");
      await connectBundle(bundle);
      const repo = bundle.repository;
      process.on("message", async () => {
        try {
          const id = Number(process.env.GRE498_WORKER_PROFILE);
          const result = process.env.GRE498_WORKER_ACTION === "delete"
            ? repo.deleteProfile(id)
            : repo.compareAndSetOwnedPlanFeatures({ profileId: id, expected: { kind: "missing" }, value: '{"farm":true}' });
          process.send({ result: result ?? "deleted" });
        } finally { await closeBundle(bundle); process.disconnect(); }
      });
      process.send("ready");
    `;
    async function startWorker(action: "delete" | "cas", id: number) {
      const url = new URL(scoped);
      url.searchParams.set("application_name", `${schemaName}_${action}`);
      const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", workerSource], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, GRE498_WORKER_URL: url.toString(), GRE498_WORKER_DIR: dataDir,
          GRE498_WORKER_PROFILE: String(id), GRE498_WORKER_ACTION: action },
      });
      workers.push(worker);
      expect((await once(worker, "message", { signal: AbortSignal.timeout(20_000) }))[0]).toBe("ready");
      return worker;
    }
    async function waitForLock(action: "delete" | "cas") {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await admin.query(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
          [`${schemaName}_${action}`],
        );
        if (result.rows[0]?.waiting === 1) return;
        await setTimeout(25);
      }
      throw new Error("Postgres worker did not wait on the profile lock");
    }
    const deletion = await startWorker("delete", profileId);
    await writer.query("BEGIN");
    await writer.query("SELECT id FROM build_profiles WHERE id = $1 FOR KEY SHARE", [profileId]);
    const deleted = once(deletion, "message", { signal: AbortSignal.timeout(20_000) });
    deletion.send("run");
    await waitForLock("delete");
    await writer.query("INSERT INTO app_settings (tenant_id, key, value) VALUES ('default', $1, $2)", [key, '{"farm":true}']);
    await writer.query("COMMIT");
    expect((await deleted)[0]).toEqual({ result: "deleted" });
    expect(repo.getOwnedProfileIdentity(profileId)).toBeNull();
    expect(repo.getSettingSnapshot(key)).toEqual({ kind: "missing" });

    const goneId = repo.createProfile("Deletion before CAS").id;
    const cas = await startWorker("cas", goneId);
    await writer.query("BEGIN");
    await writer.query("DELETE FROM build_profiles WHERE id = $1", [goneId]);
    const patched = once(cas, "message", { signal: AbortSignal.timeout(20_000) });
    cas.send("run");
    await waitForLock("cas");
    await writer.query("COMMIT");
    expect((await patched)[0]).toEqual({ result: false });
    expect(repo.getSettingSnapshot(`feature_toggles:plan:${goneId}`)).toEqual({ kind: "missing" });

    const retained = repo.createProfile("Retained settings").id;
    const keys = [`production_setup:${retained}`, `role_filaments_${retained}`, `feature_toggles:plan:${retained}`];
    for (const settingKey of keys) repo.setSetting(settingKey, "retained");
    repositoryForTenant(bundle, "foreign").deleteProfile(retained);
    expect(keys.map((settingKey) => repo.getSettingSnapshot(settingKey))).toEqual([
      { kind: "stored", value: "retained" }, { kind: "stored", value: "retained" }, { kind: "stored", value: "retained" },
    ]);
    await writer.query(`CREATE FUNCTION reject_setting_delete() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'Retained setting cannot be deleted'; END $$`);
    await writer.query(`CREATE TRIGGER reject_setting_delete BEFORE DELETE ON app_settings
      FOR EACH ROW WHEN (OLD.key = 'feature_toggles:plan:${retained}') EXECUTE FUNCTION reject_setting_delete()`);
    expect(() => repo.deleteProfile(retained)).toThrow("Retained setting cannot be deleted");
    expect(repo.getOwnedProfileIdentity(retained)).toEqual({ id: retained, name: "Retained settings", orderNumber: null, archivedAt: null });
    expect(keys.map((settingKey) => repo.getSettingSnapshot(settingKey))).toEqual([
      { kind: "stored", value: "retained" }, { kind: "stored", value: "retained" }, { kind: "stored", value: "retained" },
    ]);
    await writer.query("DROP TRIGGER reject_setting_delete ON app_settings");
    repo.deleteProfile(retained);
    expect(keys.map((settingKey) => repo.getSettingSnapshot(settingKey))).toEqual([
      { kind: "missing" }, { kind: "missing" }, { kind: "missing" },
    ]);

    const ownedId = repo.createProfile("Exact snapshot").id;
    expect(repo.compareAndSetOwnedPlanFeatures({ profileId: ownedId, expected: { kind: "missing" }, value: "" })).toBe(true);
    expect(repo.compareAndSetOwnedPlanFeatures({ profileId: ownedId, expected: { kind: "missing" }, value: "{}" })).toBe(false);
    expect(repo.compareAndSetOwnedPlanFeatures({ profileId: ownedId, expected: { kind: "stored", value: "" }, value: '{"farm":false}' })).toBe(true);
    expect(repo.getOwnedPlanFeatureSnapshots([ownedId, ownedId, goneId])).toEqual([
      { profileId: ownedId, snapshot: { kind: "stored", value: '{"farm":false}' } },
    ]);
  } finally {
    for (const worker of workers) if (worker.exitCode === null) worker.kill();
    await writer.query("ROLLBACK").catch(() => {});
    await writer.end();
    await closeBundle(bundle);
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);

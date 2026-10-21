import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function clientCases({ root, raw: original, profile, draft }) {
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const { default: Fastify } = await load("web/node_modules/fastify/fastify.js");
  const { registerPlanDraftRoutes } = await load("web/apps/server/src/routes/plan-drafts.ts");
  const { tenantStorage } = await load("web/apps/server/src/middleware/tenant-context.ts");
  const { default: Database } = await load("web/node_modules/better-sqlite3/lib/index.js");
  const { SqliteDatabase, getDb } = await load("web/apps/server/src/db/client.ts");
  const { AppRepository } = await load("web/apps/server/src/db/repository.ts");
  const schema = await load("web/apps/server/src/db/schema.ts");
  const { createApiKey, validateApiKey } = await load("web/apps/server/src/services/api-key-manager.ts");
  const snapshot = original.serialize();
  const request = {
    expected_snapshot_digest: draft.snapshotDigest,
    expected_lifecycle_version: draft.lifecycleVersion,
    expected_base: { revision_id: null, plan_version: 0 }, remap_checkoff_links: true,
  };
  const cases = [];
  for (const [id, key, actor, corrupt, credential = "session", target = "draft"] of [
    ["trim", "\ufeff\u00a0 client-key \u2029", "default", false],
    ["empty", "\ufeff \u00a0", "default", false],
    ["missing", null, "default", false],
    ["utf16-limit", "😀".repeat(80), "default", false],
    ["utf16-over", "😀".repeat(81), "default", false],
    ["embedded-bom", "client\ufeffkey", "default", false],
    ["other-tenant", "client-key", "other", false],
    ["internal-error", "client-key", "default", true],
    ["api-key", "client-key", "default", false, "api_key"],
    ["missing-draft", "client-key", "default", false, "session", "missing-draft"],
    ["mismatched-draft", "client-key", "default", false, "session", "other-plan"],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "pp-publication-client-"));
    writeFileSync(join(dir, "print-partner.db"), snapshot);
    const database = new SqliteDatabase(dir);
    database.connect();
    const raw = new Database(join(dir, "print-partner.db"));
    let counter = 0;
    const repo = new AppRepository(getDb(database), "default", database.reposDir, schema, {
      clock: () => new Date("2026-09-06T00:00:00.000Z"),
      tokenFactory: () => `ppu_${(++counter).toString(16).padStart(32, "0")}`,
    });
    // A disposable key in the temporary database; Node's own validator admits it
    // and, like API-key traffic, the request carries a tenant but no session user.
    const apiKey = credential === "api_key" ? createApiKey(repo).key : null;
    const app = Fastify();
    app.addHook("onRequest", (request, _reply, done) => {
      request.tenantId = actor;
      if (apiKey == null) request.sessionUser = { user_id: actor };
      else assert.ok(validateApiKey(repo, request.headers["x-api-key"]));
      tenantStorage.run(actor, done);
    });
    try {
      await registerPlanDraftRoutes(app, { repo, reposDir: database.reposDir, thumbsDir: database.thumbsDir, dataDir: dir });
      // Both draft cases target an owned Plan. The mismatched case adds a second
      // owned Plan through Node and records the rows it adds for the Rust replay.
      let path = { profile: profile.id, draft: draft.id };
      let seed = {};
      if (target === "missing-draft") {
        path = { ...path, draft: 999999 };
        assert.equal(raw.prepare("SELECT count(*) AS n FROM plan_drafts WHERE id=?").get(path.draft).n, 0);
      }
      if (target === "other-plan") {
        const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
        const rows = () => Object.fromEntries(tables.map((table) => [table, raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map((row) => JSON.stringify(row))]));
        const before = rows();
        path = { ...path, profile: tenantStorage.run(actor, () => repo.createProfile("Mismatched Build")).id };
        for (const [table, after] of Object.entries(rows())) {
          assert.deepEqual(after.slice(0, before[table].length), before[table], `${table}: existing rows kept`);
          if (after.length > before[table].length) seed[table] = after.slice(before[table].length).map((row) => JSON.parse(row));
        }
        assert.notEqual(path.profile, profile.id);
        assert.equal(raw.prepare("SELECT count(*) AS n FROM plan_drafts WHERE profile_id=?").get(path.profile).n, 0);
      }
      if (corrupt) raw.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON plan_revisions BEGIN SELECT RAISE(ABORT,'Rust-only probe detail'); END");
      const inject = () => app.inject({ method: "POST", url: `/plans/${path.profile}/drafts/${path.draft}/apply`, headers: { ...(key == null ? {} : { "idempotency-key": key }), ...(apiKey == null ? {} : { "x-api-key": apiKey }) }, payload: request });
      const response = await inject();
      const body = response.json();
      const receipt = raw.prepare("SELECT idempotency_key,actor_id FROM plan_apply_requests").get() ?? null;
      const revision = raw.prepare("SELECT created_by,accepted_by FROM plan_revisions").get() ?? null;
      let replay = null;
      if (response.statusCode === 200) {
        const again = await inject();
        replay = { status: again.statusCode, body: again.json() };
        assert.deepEqual(replay.body, body);
        assert.equal(raw.prepare("SELECT count(*) AS n FROM plan_apply_requests").get().n, 1);
      }
      cases.push({ id, key, tenant: actor, credential, corrupt, request, profile: path.profile, draft: path.draft, seed, status: response.statusCode, body, receipt, revision, replay });
    } finally {
      await app.close(); raw.close(); database.close(); rmSync(dir, { recursive: true, force: true });
    }
  }
  return cases;
}

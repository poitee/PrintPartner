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
  const snapshot = original.serialize();
  const request = {
    expected_snapshot_digest: draft.snapshotDigest,
    expected_lifecycle_version: draft.lifecycleVersion,
    expected_base: { revision_id: null, plan_version: 0 }, remap_checkoff_links: true,
  };
  const cases = [];
  for (const [id, key, actor, corrupt] of [
    ["trim", "\ufeff\u00a0 client-key \u2029", "default", false],
    ["empty", "\ufeff \u00a0", "default", false],
    ["missing", null, "default", false],
    ["utf16-limit", "😀".repeat(80), "default", false],
    ["utf16-over", "😀".repeat(81), "default", false],
    ["embedded-bom", "client\ufeffkey", "default", false],
    ["other-tenant", "client-key", "other", false],
    ["internal-error", "client-key", "default", true],
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
    const app = Fastify();
    app.addHook("onRequest", (request, _reply, done) => {
      request.tenantId = actor;
      request.sessionUser = { user_id: actor };
      tenantStorage.run(actor, done);
    });
    try {
      await registerPlanDraftRoutes(app, { repo, reposDir: database.reposDir, thumbsDir: database.thumbsDir, dataDir: dir });
      if (corrupt) raw.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON plan_revisions BEGIN SELECT RAISE(ABORT,'Rust-only probe detail'); END");
      const inject = () => app.inject({ method: "POST", url: `/plans/${profile.id}/drafts/${draft.id}/apply`, headers: key == null ? {} : { "idempotency-key": key }, payload: request });
      const response = await inject();
      const body = response.json();
      const receipt = raw.prepare("SELECT idempotency_key,actor_id FROM plan_apply_requests").get() ?? null;
      let replay = null;
      if (response.statusCode === 200) {
        const again = await inject();
        replay = { status: again.statusCode, body: again.json() };
        assert.deepEqual(replay.body, body);
        assert.equal(raw.prepare("SELECT count(*) AS n FROM plan_apply_requests").get().n, 1);
      }
      cases.push({ id, key, tenant: actor, corrupt, request, profile: profile.id, draft: draft.id, status: response.statusCode, body, receipt, replay });
    } finally {
      await app.close(); raw.close(); database.close(); rmSync(dir, { recursive: true, force: true });
    }
  }
  return cases;
}

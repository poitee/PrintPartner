import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const server = join(root, 'web/apps/server/src');
const { createSelfHostPorts } = await import(join(server, 'adapters/self-host/index.ts'));
const { PlanDraftWorkspaceService } = await import(join(server, 'services/plan-draft-workspace.ts'));
const { tenantStorage } = await import(join(server, 'middleware/tenant-context.ts'));
const fixture = join(root, 'rust/crates/pp-storage/tests/fixtures/required-units/unchanged.db');
const exportTables = ['projects', 'build_profiles', 'profile_layers', 'plan_drafts', 'plan_draft_inputs', 'plan_draft_parts'];
const quote = name => `"${name.replaceAll('"', '""')}"`;
const select = (db, table) => db.prepare(`SELECT * FROM ${quote(table)} ORDER BY id`).all();
function snapshot(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [
    name, db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(row)).sort(),
  ]);
}
function observe(db) {
  return { version: db.prepare('PRAGMA data_version').get().data_version, rows: snapshot(db) };
}
function response(repo, service, check) {
  const { profileId, request, draftId } = check;
  if (!repo.getOwnedProfileIdentity(profileId)) {
    assert.equal(service.read(profileId, draftId ?? 2).kind, 'profile_not_found');
    return JSON.stringify({ kind: 'profile_not_found' });
  }
  if (request === 'list') return JSON.stringify({ kind: 'listed', drafts: repo.listPlanDraftIdentities(profileId) });
  const draft = repo.getPlanDraft(profileId, draftId);
  if (!draft) {
    assert.equal(service.read(profileId, draftId).kind, 'draft_not_found');
    return JSON.stringify({ kind: 'draft_not_found' });
  }
  if (request === 'read') return JSON.stringify({ kind: 'read', draft });
  if (request === 'diff') return JSON.stringify({ kind: 'diff', diff: repo.diffPlanDraft(profileId, draftId) });
  assert.equal(request, 'workspace');
  const result = service.read(profileId, draftId);
  assert.equal(result.kind, 'ready');
  return JSON.stringify({ kind: 'workspace', workspace: result.workspace });
}

const cases = [];
const scenarios = [
  { name: 'open0', transitions: [] },
  { name: 'abandoned1', transitions: ['abandon'] },
  { name: 'resumed2', transitions: ['abandon', 'resume'] },
  { name: 'abandoned3', transitions: ['abandon', 'resume', 'abandon'] },
  { name: 'list-created-before-id', transitions: [], order: true },
];
mock.timers.enable({ apis: ['Date'], now: Date.parse('2000-01-01T00:00:00.000Z') });
try {
  for (const { name, transitions, order } of scenarios) {
    const directory = mkdtempSync(join(tmpdir(), 'pp-draft-read-diff-'));
    const database = join(directory, 'print-partner.db');
    copyFileSync(fixture, database);
    const ports = createSelfHostPorts(directory, undefined, 'existing-current-schema');
    await ports.db.connect();
    const observer = new DatabaseSync(database);
    const setup = [];
    try {
      let repo = ports.repository;
      let service = new PlanDraftWorkspaceService(repo);
      function record(run) {
        const before = new Map(exportTables.map(table => [table, select(observer, table)]));
        const result = run();
        for (const table of exportTables) {
          const previous = new Map(before.get(table).map(row => [row.id, row]));
          for (const row of select(observer, table)) {
            const old = previous.get(row.id);
            if (JSON.stringify(old) === JSON.stringify(row)) continue;
            if (old) {
              const columns = Object.keys(row).filter(key => row[key] !== old[key]);
              setup.push({ sql: `UPDATE ${table} SET ${columns.map(key => `${key}=?`).join(',')} WHERE id=?`, params: [...columns.map(key => row[key]), row.id] });
            } else {
              const rowWithoutCheckout = table === 'projects' ? { ...row, local_path: null } : row;
              const columns = Object.keys(rowWithoutCheckout);
              setup.push({ sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, params: Object.values(rowWithoutCheckout) });
            }
          }
        }
        return result;
      }
      const owners = ['default', 'foreign'].map(tenant => tenantStorage.run(tenant, () => record(() => {
        const checkout = join(directory, tenant);
        mkdirSync(checkout);
        writeFileSync(join(checkout, 'fake.stl'), 'solid fake\nendsolid fake\n');
        const source = repo.createSource({ name: `Parity Source ${tenant}`, source_kind: 'local', local_path: checkout });
        const profile = repo.createProfile(`Parity Build ${tenant}`, source.id);
        const result = repo.recomputePlanDraft({ profileId: profile.id, actor: tenant, idempotencyKey: `gre880-${tenant}`, applyManifest: false, preferAccepted: true });
        assert.equal(result.kind, 'created');
        assert.equal(repo.getPlanDraft(profile.id, result.draft.id).id, result.draft.id);
        assert.equal(service.read(profile.id, result.draft.id).kind, 'ready');
        return { profileId: profile.id, draftId: result.draft.id };
      })));
      transitions.forEach((kind, version) => record(() => {
        if (kind === 'abandon') {
          const result = service.abandon({ profileId: 1, draftId: 2, request: { expected_lifecycle_version: version } });
          assert.equal(result.kind, 'ready');
        } else {
          const result = repo.transitionPlanDraft({ profileId: 1, draftId: 2, transition: { kind, expectedLifecycleVersion: version } });
          assert.equal(result.kind, 'transitioned');
        }
        assert.equal(repo.getPlanDraft(1, 2).lifecycleVersion, version + 1);
      }));
      if (order) record(() => {
        const result = repo.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: 'gre880-order', applyManifest: false, preferAccepted: true });
        assert.equal(result.kind, 'created');
        assert.deepEqual(repo.listPlanDraftIdentities(1).map(draft => draft.id), [result.draft.id, 1, 2]);
      });
      const checks = [];
      const add = (label, profileId, draftId, requests) => {
        for (const request of requests) checks.push({ name: `${label}-${request}`, profileId, request, ...(request === 'list' ? {} : { draftId }) });
      };
      const all = ['list', 'read', 'diff', 'workspace'];
      add('target', 1, 2, all);
      add('consumed1', 1, 1, all.slice(1));
      add('foreign-profile2', 2, owners[1].draftId, all);
      add('foreign-owner-profile', owners[1].profileId, owners[1].draftId, all);
      add('missing-profile', 999, 2, all);
      add('same-tenant-other-draft', 1, owners[0].draftId, all.slice(1));
      add('foreign-draft', 1, owners[1].draftId, all.slice(1));
      add('missing-draft', 1, 999, all.slice(1));
      const before = observe(observer);
      for (const check of checks) check.body = response(repo, service, check);
      for (const check of checks) assert.equal(response(repo, service, check), check.body, check.name);
      assert.deepEqual(observe(observer), before, `${name} repeated reads mutated SQLite`);
      await ports.db.close();
      await ports.db.connect();
      repo = ports.repository;
      service = new PlanDraftWorkspaceService(repo);
      for (const check of checks) assert.equal(response(repo, service, check), check.body, `${check.name} after reopen`);
      assert.deepEqual(observe(observer), before, `${name} reopened reads mutated SQLite`);
      const replayDirectory = join(directory, 'replay');
      mkdirSync(replayDirectory);
      const replayDatabase = join(replayDirectory, 'print-partner.db');
      copyFileSync(fixture, replayDatabase);
      const replay = new DatabaseSync(replayDatabase);
      try {
        replay.exec('PRAGMA foreign_keys=ON');
        for (const statement of setup) replay.prepare(statement.sql).run(...statement.params);
      } finally {
        replay.close();
      }
      const replayPorts = createSelfHostPorts(replayDirectory, undefined, 'existing-current-schema');
      await replayPorts.db.connect();
      try {
        const replayService = new PlanDraftWorkspaceService(replayPorts.repository);
        for (const check of checks) assert.equal(response(replayPorts.repository, replayService, check), check.body, `${check.name} SQL replay`);
      } finally {
        await replayPorts.db.close();
      }
      cases.push({ name, setup, checks });
    } finally {
      observer.close();
      await ports.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  mock.timers.reset();
}
const output = `[\n${cases.map(entry => `  {"name":${JSON.stringify(entry.name)},\n   "setup":[\n${entry.setup.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n   ],\n   "checks":[\n${entry.checks.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n   ]}`).join(',\n')}\n]\n`;
const target = join(here, 'node.json');
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(target, 'utf8'), output, 'Node draft read/diff fixture differs. Regenerate and review node.json.');
  console.log(`Checked ${cases.length} draft read/diff parity cases.`);
} else {
  writeFileSync(target, output);
  console.log(`Generated ${cases.length} draft read/diff parity cases.`);
}

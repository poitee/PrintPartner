// From web/: node --conditions=development --import tsx ../rust/crates/pp-storage/tests/fixtures/required-units/gaps-node.mjs [--check]
// Set TMPDIR to a scratch directory outside the checkout.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve('apps/server');
const { reconcileRequiredUnits } = await import(join(server, 'src/services/required-unit-reconciliation.ts'));
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const { PlanDraftWorkspaceService } = await import(join(server, 'src/services/plan-draft-workspace.ts'));

const unit = (n, priorIndex, completed = false) => ({
  token: `ppu_${n.toString(16).padStart(32, '0')}`, priorIndex,
  createdAt: '2026-08-20T09:00:00.000Z', completed, assembled: false,
});
const base = (id, units = [unit(id, 0)]) => ({
  id, sourceId: 5, artifactDigest: 'a'.repeat(64), roleInferred: 'primary', roleOverride: null, units,
});
const part = (id, predecessor, quantityEffective = 1) => ({
  id, baseRevisionPartId: predecessor, sourceLayer: 'source', artifactDigest: 'a'.repeat(64),
  roleInferred: 'primary', roleOverride: null, quantityEffective,
});
const input = { sourceId: 5, sourceLayer: 'source' };
const run = (parts, baseParts, inputs = [input]) => reconcileRequiredUnits({
  draft: { parts, inputs }, baseParts, baseMappingDigest: null, decisions: [],
});
const output = {
  surplus: run([], [base(10, [unit(4, 0), unit(1, 1)])]),
  basis: run([part(21, 11), part(22, 10)], [
    base(10, [unit(1, 0), unit(2, 1)]), base(11, [unit(3, 0), unit(4, 1)]),
  ]),
  nullSource: run([part(21, null)], [{ ...base(10), sourceId: null }], [input, input]),
  nullArtifact: run([{ ...part(21, null), artifactDigest: null }], [{ ...base(10), artifactDigest: null }]),
  tokenTie: run([part(21, 10)], [base(10, [unit(4, 0, true), unit(3, 1, true)])]),
  priorOrder: run([part(21, 10, 2)], [base(10, [unit(4, 0, true), unit(1, 1), {
    ...unit(3, 2, true), createdAt: '2026-08-20T08:00:00.000Z',
  }])]),
};

const directory = mkdtempSync(join(tmpdir(), 'pp-required-unit-gaps-'));
copyFileSync(join(here, 'unchanged.db'), join(directory, 'print-partner.db'));
const ports = createSelfHostPorts(directory);
await ports.db.connect();
const raw = new DatabaseSync(join(directory, 'print-partner.db'));
try {
  const setup = [
    `INSERT INTO plan_revisions (id,tenant_id,profile_id,revision_number,parent_revision_id,input_set_id,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at)
     SELECT 2,tenant_id,profile_id,2,id,input_set_id,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at FROM plan_revisions WHERE id=1`,
    'UPDATE build_profiles SET accepted_plan_revision_id=2,accepted_plan_version=(SELECT base_plan_version FROM plan_drafts WHERE id=2) WHERE id=1',
  ];
  for (const sql of setup) raw.exec(sql);
  const rows = (sql) => raw.prepare(sql).all().map((row) => Object.values(row));
  const selection = () => ({
    draft: rows('SELECT id,state,digest_format,current_required_unit_reconciliation_id,snapshot_digest FROM plan_drafts WHERE id=2'),
    reconciliations: rows('SELECT * FROM plan_draft_required_unit_reconciliations ORDER BY id'),
    assignments: rows('SELECT * FROM plan_draft_required_unit_assignments ORDER BY reconciliation_id,target_draft_part_id,unit_index'),
    decisions: rows('SELECT * FROM plan_draft_required_unit_decisions ORDER BY reconciliation_id,target_draft_part_id'),
  });
  const before = selection();
  const request = JSON.parse(readFileSync(join(here, 'unchanged.json'), 'utf8')).request;
  const result = new PlanDraftWorkspaceService(ports.repository).reconcile({
    profileId: 1, draftId: 2, actorId: 'default', idempotencyKey: 'revision-base', request,
  });
  assert.equal(result.kind, 'base_changed');
  assert.deepEqual(selection(), before);
  output.revisionBase = { setup, result };
} finally {
  raw.close();
  await ports.db.close();
  rmSync(directory, { recursive: true, force: true });
}
const path = join(here, 'gaps-node.json');
const bytes = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(path, 'utf8'), bytes);
  console.log('gaps-node.json matches the Node required-unit service');
} else {
  writeFileSync(path, bytes);
  console.log('Wrote gaps-node.json from the Node required-unit service');
}

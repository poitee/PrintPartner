// From web/: TMPDIR=<scratch> node --conditions=development --import tsx ../fixtures/parity/required-unit-decisions/generate.mjs [--check]
// Replays Required-unit decisions through PlanDraftWorkspaceService on disposable copies of accepted Plan fixtures.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const server = join(root, 'web/apps/server');
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const { PlanDraftWorkspaceService } = await import(join(server, 'src/services/plan-draft-workspace.ts'));
const { parseEditPlanDraftPartsRequest, parseReconcilePlanDraftRequest } = await import(join(server, '../../packages/contracts/src/index.ts'));

const fixtures = 'rust/crates/pp-storage/tests/fixtures';
const include = (id, value) => ({ kind: 'set_included', draft_part_ids: [id], value });
const quantity = (id, value) => ({ kind: 'set_quantity_override', draft_part_ids: [id], value });
const edit = (...decisions) => ({ op: 'edit', decisions });
const reconcile = (key, ...decisions) => ({ op: 'reconcile', key, decisions });
const replay = (key) => ({ op: 'reconcile', key, replay: true });
const accept = (target, predecessor) => ({ kind: 'accept_prior_completion', target_draft_part_id: target, predecessor_revision_part_id: predecessor });
const replace = (target) => ({ kind: 'replace', target_draft_part_id: target });
const reopen = { op: 'reopen' };

// accepted-plate-node.db: draft Part 3 (excluded) and Part 4 (on the immutable Plate) succeed
// revision Parts 1 and 2, whose single units are completed and assembled.
// unsafe.db: draft Part 4 changed its artifact, so revision Part 1 (tokens 1-3) is an unsafe predecessor.
const cases = [
  { name: 'plate-exclude-restore-split', database: `${fixtures}/accepted-plate-node.db`, setup: [], calls: [
    reconcile('baseline'),
    edit(include(3, true)),
    edit(include(4, false)),
    edit(quantity(4, 3)),
    edit(include(4, true), quantity(4, null)),
    reopen,
    replay('baseline'),
    reconcile('reopened'),
    replay('reopened'),
  ] },
  { name: 'unsafe-retain-completed-split', database: `${fixtures}/required-units/unsafe.db`, setup: [
    'UPDATE print_progress SET completed=1 WHERE part_id=1 AND unit_index=1',
  ], calls: [
    reconcile('undecided'),
    reconcile('accept', accept(4, 1)),
    edit(quantity(4, 1)),
    reconcile('accept-one', accept(4, 1)),
    reopen,
    replay('accept-one'),
    reconcile('replace', replace(4)),
    replay('accept'),
  ] },
];

const queries = {
  history: {
    units: 'SELECT token,profile_id,created_in_revision_id,object_name,created_at FROM required_units ORDER BY token',
    mapping: 'SELECT revision_id,revision_part_id,unit_index,required_unit_token FROM plan_revision_required_units ORDER BY revision_part_id,unit_index',
    progress: 'SELECT part_id,unit_index,completed,assembled FROM print_progress ORDER BY part_id,unit_index',
    plateRevisions: 'SELECT * FROM accepted_plate_revisions ORDER BY id',
    plateHeads: 'SELECT * FROM accepted_plate_heads ORDER BY profile_id',
    plates: 'SELECT * FROM accepted_plates ORDER BY revision_id,plate_id',
    plateUnits: 'SELECT * FROM accepted_plate_units ORDER BY revision_id,required_unit_token',
  },
  state: {
    drafts: 'SELECT id,state,digest_format,current_required_unit_reconciliation_id,snapshot_digest FROM plan_drafts ORDER BY id',
    parts: 'SELECT id,draft_id,base_revision_part_id,included,quantity_override,quantity_effective FROM plan_draft_parts ORDER BY id',
    reconciliations: 'SELECT id AS reconciliation_id,draft_id,actor_id,idempotency_key,result_kind,reconciliation_digest,payload_digest,expected_assignment_count,finalized_at IS NOT NULL AS finalized FROM plan_draft_required_unit_reconciliations ORDER BY id',
    decisions: 'SELECT reconciliation_id,target_draft_part_id,kind,predecessor_revision_part_id FROM plan_draft_required_unit_decisions ORDER BY reconciliation_id,target_draft_part_id',
    assignments: 'SELECT reconciliation_id,target_draft_part_id,unit_index,kind,required_unit_token FROM plan_draft_required_unit_assignments ORDER BY reconciliation_id,target_draft_part_id,unit_index',
  },
};

// Across one whole case, tokens and reconciliation IDs become labels numbered by sorted value, so every
// equality link survives and no label depends on traversal order. The Rust test applies the same rule.
const TOKEN = /^ppu_[0-9a-f]{32}$/;
const RECONCILIATION = new Set(['reconciliation_id', 'current_required_unit_reconciliation_id']);
function normalize(value) {
  const tokens = new Set();
  const ids = new Set();
  const collect = (node, key) => {
    if (Array.isArray(node)) node.forEach((item) => collect(item, key));
    else if (node && typeof node === 'object') Object.entries(node).forEach(([k, v]) => collect(v, k));
    else if (typeof node === 'string' && TOKEN.test(node)) tokens.add(node);
    else if (typeof node === 'number' && RECONCILIATION.has(key)) ids.add(node);
  };
  collect(value);
  const tokenLabels = new Map([...tokens].sort().map((token, index) => [token, `unit#${index}`]));
  const idLabels = new Map([...ids].sort((a, b) => a - b).map((id, index) => [id, `reconciliation#${index}`]));
  const rewrite = (node, key) => {
    if (Array.isArray(node)) return node.map((item) => rewrite(item, key));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rewrite(v, k)]));
    if (typeof node === 'string' && tokenLabels.has(node)) return tokenLabels.get(node);
    if (typeof node === 'number' && RECONCILIATION.has(key)) return idLabels.get(node);
    return node;
  };
  return rewrite(value);
}

const output = [];
for (const { name, database, setup, calls } of cases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-required-unit-decisions-'));
  copyFileSync(join(root, database), join(directory, 'print-partner.db'));
  let raw = new DatabaseSync(join(directory, 'print-partner.db'));
  let ports;
  try {
    for (const sql of setup) raw.exec(sql);
    const read = (group) => Object.fromEntries(Object.entries(queries[group]).map(([table, sql]) => [table, raw.prepare(sql).all().map((row) => ({ ...row }))]));
    const before = read('history');
    assert.ok(before.progress.some((row) => row.completed === 1), `${name} has completed history`);
    raw.close();
    ports = createSelfHostPorts(directory);
    await ports.db.connect();
    raw = new DatabaseSync(join(directory, 'print-partner.db'));
    let service = new PlanDraftWorkspaceService(ports.repository);
    const steps = [];
    let reopenedAt = null;
    for (const call of calls) {
      if (call.op === 'reopen') {
        reopenedAt = steps.length;
        raw.close();
        await ports.db.close();
        ports = createSelfHostPorts(directory);
        await ports.db.connect();
        raw = new DatabaseSync(join(directory, 'print-partner.db'));
        service = new PlanDraftWorkspaceService(ports.repository);
        continue;
      }
      const [{ snapshot_digest: expected }] = raw.prepare('SELECT snapshot_digest FROM plan_drafts WHERE id=2').all();
      const request = call.replay
        ? steps.find((step) => step.key === call.key).request
        : { expected_snapshot_digest: expected, decisions: call.decisions };
      const result = call.op === 'edit'
        ? service.editParts({ profileId: 1, draftId: 2, actorId: 'default', request: parseEditPlanDraftPartsRequest(request) })
        : service.reconcile({ profileId: 1, draftId: 2, actorId: 'default', idempotencyKey: call.key, request: parseReconcilePlanDraftRequest(request) });
      steps.push({ op: call.op, key: call.key ?? null, request, result, state: read('state') });
    }
    const after = read('history');
    assert.deepEqual(after, before, `${name} keeps Required-unit and Plate history`);
    assert.notEqual(reopenedAt, null);
    output.push(normalize({ name, database, setup, reopenedAt, history: before, steps }));
  } finally {
    raw.close();
    await ports?.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const path = join(here, 'node.json');
// One step per line keeps the literal Node outcomes reviewable.
const line = (value) => JSON.stringify(value);
const bytes = `{"_generated": "@generated by fixtures/parity/required-unit-decisions/generate.mjs",\n"queries": ${line(queries)},\n"cases": [\n${output.map(({ steps, ...header }) =>
  `${line(header).slice(0, -1)}, "steps": [\n${steps.map(line).join(',\n')}\n]}`).join(',\n')}\n]}\n`;
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(path, 'utf8'), bytes, 'Required-unit decision fixtures are stale');
  console.log('node.json matches the Node Required-unit decisions');
} else {
  writeFileSync(path, bytes);
  console.log(`Wrote ${output.length} Required-unit decision cases to node.json`);
}

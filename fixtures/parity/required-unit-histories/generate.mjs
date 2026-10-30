// From web/: TMPDIR=<scratch> node --conditions=development --import tsx ../fixtures/parity/required-unit-histories/generate.mjs [--check]
// Replays seeded random Required-unit histories through PlanDraftWorkspaceService on disposable copies of
// the Required-unit fixtures. Each history mixes inclusion and quantity edits, valid and invalid reconcile
// decisions in shuffled order, stale digests, key replays and changed payloads, and one restart.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const server = join(root, 'web/apps/server');
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const { PlanDraftWorkspaceService } = await import(join(server, 'src/services/plan-draft-workspace.ts'));
const { parseEditPlanDraftPartsRequest, parseReconcilePlanDraftRequest } = await import(join(server, '../../packages/contracts/src/index.ts'));

const fixtures = 'rust/crates/pp-storage/tests/fixtures';
const databases = [
  `${fixtures}/accepted-plate-node.db`,
  `${fixtures}/required-units/unchanged.db`,
  `${fixtures}/required-units/shrink.db`,
  `${fixtures}/required-units/unsafe.db`,
];
const HISTORIES_PER_DATABASE = 6;
const STEPS = 12;

// mulberry32: a small seeded generator, so every history is reproducible from its seed.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const queries = {
  history: {
    units: 'SELECT token,profile_id,created_in_revision_id,object_name,created_at FROM required_units ORDER BY token',
    mapping: 'SELECT revision_id,revision_part_id,unit_index,required_unit_token FROM plan_revision_required_units ORDER BY revision_part_id,unit_index',
    progress: 'SELECT part_id,unit_index,completed,assembled FROM print_progress ORDER BY part_id,unit_index',
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

// Tokens and reconciliation IDs across one whole history become labels numbered by sorted value, as in
// ../required-unit-decisions/generate.mjs. The Rust test applies the same rule.
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

// Sorted keys at every level, so the digest does not depend on either runtime's key order.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The compact, literal part of a step: the outcome kind, the Part view, the conflicts and the selected
// assignments. The digest covers the full result and every state row.
function summary({ result, state }) {
  if (result.error) return { error: result.error };
  const draft = state.drafts.find((row) => row.id === 2);
  const current = draft.current_required_unit_reconciliation_id;
  return {
    kind: result.kind,
    reconciliation: result.workspace?.reconciliation ?? null,
    parts: state.parts.filter((p) => p.draft_id === 2).map((p) => [p.id, p.base_revision_part_id, p.included, p.quantity_effective]),
    decisions: state.decisions.filter((d) => d.reconciliation_id === current).map((d) => [d.target_draft_part_id, d.kind, d.predecessor_revision_part_id]),
    selection: state.assignments.filter((a) => a.reconciliation_id === current).map((a) => [a.target_draft_part_id, a.unit_index, a.kind, a.required_unit_token]),
  };
}

const pick = (next, items) => items[Math.floor(next() * items.length)];
function shuffle(next, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The decisions that answer the last workspace's conflicts, each chosen at random between its valid kinds.
function answers(next, conflicts) {
  return conflicts.map((conflict) => (conflict.kind === 'unsafe_predecessor' && next() < 0.6
    ? { kind: 'accept_prior_completion', target_draft_part_id: conflict.target_draft_part_id, predecessor_revision_part_id: conflict.predecessor_revision_part_id }
    : { kind: 'replace', target_draft_part_id: conflict.target_draft_part_id }));
}

// One decision Node refuses: a wrong predecessor (invalid reassignment), a replace or accept on a Part
// with a safe predecessor (invalid retirement), an exact selection on an unsafe Part, or a missing Part.
function invalid(next, parts, conflicts) {
  const unsafe = conflicts.filter((c) => c.kind === 'unsafe_predecessor');
  const safe = parts.filter((p) => !unsafe.some((c) => c.target_draft_part_id === p.id));
  const reassignments = [];
  for (const conflict of unsafe) {
    const other = parts.find((p) => p.base_revision_part_id !== conflict.predecessor_revision_part_id);
    if (other) reassignments.push({ kind: 'accept_prior_completion', target_draft_part_id: conflict.target_draft_part_id, predecessor_revision_part_id: other.base_revision_part_id });
    reassignments.push({ kind: 'select_exact_predecessor', target_draft_part_id: conflict.target_draft_part_id, predecessor_revision_part_id: conflict.predecessor_revision_part_id });
  }
  if (reassignments.length > 0 && next() < 0.6) return pick(next, reassignments);
  const options = [{ kind: 'replace', target_draft_part_id: 99 }];
  for (const part of safe) {
    options.push({ kind: 'replace', target_draft_part_id: part.id });
    options.push({ kind: 'accept_prior_completion', target_draft_part_id: part.id, predecessor_revision_part_id: part.base_revision_part_id });
  }
  return pick(next, options);
}

function plan(seed, progress) {
  const next = random(seed);
  const setup = [];
  const undone = progress.filter((row) => row.completed === 0);
  if (undone.length > 0 && next() < 0.5) {
    const row = pick(next, undone);
    setup.push(`UPDATE print_progress SET completed=1 WHERE part_id=${row.part_id} AND unit_index=${row.unit_index}`);
  }
  return { next, setup, reopenAt: 3 + Math.floor(next() * (STEPS - 5)) };
}

function choose(next, parts, steps, conflicts) {
  const keyed = steps.filter((step) => step.op === 'reconcile' && !step.result.error);
  const roll = next();
  if (roll < 0.3) {
    const part = pick(next, parts).id;
    const included = { kind: 'set_included', draft_part_ids: [part], value: next() < 0.5 };
    const quantity = { kind: 'set_quantity_override', draft_part_ids: [pick(next, parts).id], value: pick(next, [null, 1, 2, 3, 4]) };
    return { op: 'edit', decisions: next() < 0.3 ? shuffle(next, [included, quantity]) : [pick(next, [included, quantity])] };
  }
  if (roll < 0.6) return { op: 'reconcile', key: `k${steps.length}`, decisions: shuffle(next, answers(next, conflicts)) };
  if (roll < 0.75) {
    return { op: 'reconcile', key: `k${steps.length}`, decisions: shuffle(next, [invalid(next, parts, conflicts), ...answers(next, conflicts)].filter(
      (decision, index, all) => all.findIndex((other) => other.target_draft_part_id === decision.target_draft_part_id) === index,
    )) };
  }
  if (roll < 0.85 && keyed.length > 0) return { op: 'reconcile', key: pick(next, keyed).key, replay: true };
  if (roll < 0.92 && keyed.length > 0) return { op: 'reconcile', key: pick(next, keyed).key, decisions: answers(next, conflicts) };
  if (steps.length > 0) return { op: 'reconcile', key: `k${steps.length}`, stale: true, decisions: answers(next, conflicts) };
  return { op: 'reconcile', key: 'k0', decisions: [] };
}

const output = [];
for (const [d, database] of databases.entries()) {
  for (let h = 0; h < HISTORIES_PER_DATABASE; h += 1) {
    const seed = 1000 * (d + 1) + h;
    const directory = mkdtempSync(join(tmpdir(), 'pp-required-unit-histories-'));
    copyFileSync(join(root, database), join(directory, 'print-partner.db'));
    let raw = new DatabaseSync(join(directory, 'print-partner.db'));
    let ports;
    try {
      const read = (group) => Object.fromEntries(Object.entries(queries[group]).map(([table, sql]) => [table, raw.prepare(sql).all().map((row) => ({ ...row }))]));
      const parts = raw.prepare('SELECT id,base_revision_part_id FROM plan_draft_parts WHERE draft_id=2 ORDER BY id').all().map((row) => ({ ...row }));
      const progress = raw.prepare('SELECT part_id,unit_index,completed FROM print_progress ORDER BY part_id,unit_index').all().map((row) => ({ ...row }));
      const { next, setup, reopenAt } = plan(seed, progress);
      for (const sql of setup) raw.exec(sql);
      const history = read('history');
      raw.close();
      ports = createSelfHostPorts(directory);
      await ports.db.connect();
      raw = new DatabaseSync(join(directory, 'print-partner.db'));
      let service = new PlanDraftWorkspaceService(ports.repository);
      const steps = [];
      const digests = [];
      let conflicts = [];
      while (steps.length < STEPS) {
        if (steps.length === reopenAt) {
          raw.close();
          await ports.db.close();
          ports = createSelfHostPorts(directory);
          await ports.db.connect();
          raw = new DatabaseSync(join(directory, 'print-partner.db'));
          service = new PlanDraftWorkspaceService(ports.repository);
        }
        const call = choose(next, parts, steps, conflicts);
        const [{ snapshot_digest: current }] = raw.prepare('SELECT snapshot_digest FROM plan_drafts WHERE id=2').all();
        if (!digests.includes(current)) digests.push(current);
        const stale = digests.find((digest) => digest !== current) ?? 'f'.repeat(64);
        const request = call.replay
          ? steps.find((step) => step.key === call.key && !step.result.error).request
          : { expected_snapshot_digest: call.stale ? stale : current, decisions: call.decisions };
        const before = read('state');
        let result;
        try {
          result = call.op === 'edit'
            ? service.editParts({ profileId: 1, draftId: 2, actorId: 'default', request: parseEditPlanDraftPartsRequest(request) })
            : service.reconcile({ profileId: 1, draftId: 2, actorId: 'default', idempotencyKey: call.key, request: parseReconcilePlanDraftRequest(request) });
        } catch (error) {
          result = { error: error.message };
        }
        const state = read('state');
        if (result.error) assert.deepEqual(state, before, `seed ${seed} step ${steps.length} rolls back`);
        if (result.workspace?.reconciliation) conflicts = result.workspace.reconciliation.conflicts ?? [];
        steps.push({ op: call.op, key: call.key ?? null, request, result, state });
      }
      assert.deepEqual(read('history'), history, `seed ${seed} keeps Required-unit and Plate history`);
      const normalized = normalize({ history, steps });
      output.push({
        name: `seed-${seed}`, database, setup, reopenedAt: reopenAt, history: normalized.history,
        steps: normalized.steps.map((step) => ({
          op: step.op, key: step.key, request: step.request, ...summary(step),
          digest: sha256(canonical({ result: step.result, state: step.state })),
        })),
      });
    } finally {
      raw.close();
      await ports?.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

const path = join(here, 'node.json');
const line = (value) => JSON.stringify(value);
const bytes = `{"_generated": "@generated by fixtures/parity/required-unit-histories/generate.mjs",\n"queries": ${line(queries)},\n"histories": [\n${output.map(({ steps, ...header }) =>
  `${line(header).slice(0, -1)}, "steps": [\n${steps.map(line).join(',\n')}\n]}`).join(',\n')}\n]}\n`;
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(path, 'utf8'), bytes, 'Required-unit history fixtures are stale');
  console.log(`node.json matches ${output.length} Node Required-unit histories`);
} else {
  writeFileSync(path, bytes);
  console.log(`Wrote ${output.length} Required-unit histories (${output.reduce((n, h) => n + h.steps.length, 0)} steps) to node.json`);
}

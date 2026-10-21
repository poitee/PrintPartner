// From web/: node --conditions=development --import tsx ../fixtures/parity/checkoff-transactions/generate.mjs [--check]
// Replays Accepted Checkoff progress through the repository on disposable copies of recorded fixtures.
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
const { acceptedPlanBasis } = await import(join(server, 'src/db/accepted-plan-progress.ts'));
const { parseRequiredUnitToken } = await import(join(server, 'src/services/required-units.ts'));
const { isPlanDraftContractError, parseAcceptedProgressImportRequest } = await import(join(root, 'web/packages/contracts/src/index.ts'));

const queries = {
  units: 'SELECT token, profile_id, object_name FROM required_units ORDER BY token',
  progress: 'SELECT part_id, unit_index, completed, assembled FROM print_progress ORDER BY part_id, unit_index',
};

// unchanged.db stores six Required units. The setup records one assembled physical result
// before any request, the same way a prior Checkoff write would have left it.
const cases = [
  { name: 'recorded-physical-result', database: 'rust/crates/pp-storage/tests/fixtures/required-units/unchanged.db', setup: [
    'UPDATE print_progress SET completed=1, assembled=1 WHERE part_id=1 AND unit_index=0',
  ], calls: [
    { op: 'complete', partId: 1, unitIndex: 1, completed: true },
    { op: 'replay' },
    { op: 'reopen' },
    { op: 'replay' },
    { op: 'import', rows: [{ part_id: 1, printed_count: 2 }] },
    { op: 'replay' },
    { op: 'import', rows: [{ part_id: 1, printed_count: 2 }, { part_id: 1, printed_count: 1 }] },
    { op: 'stale', kind: 'complete', partId: 1, unitIndex: 1, completed: false },
  ] },
];

function snakeBasis(snapshot) {
  const basis = acceptedPlanBasis(snapshot);
  return {
    profile_id: basis.profileId,
    plan_version: basis.planVersion,
    plan_revision_id: basis.revisionId,
    plan_revision_digest: basis.revisionDigest,
    required_unit_mapping_digest: basis.requiredUnitMappingDigest,
  };
}

function tokenFor(raw, partId, unitIndex) {
  const row = raw.prepare(`
    SELECT m.required_unit_token AS token
    FROM plan_revision_required_units m
    JOIN plan_revision_parts p ON p.id = m.revision_part_id AND p.revision_id = m.revision_id
    WHERE p.projection_part_id = ? AND m.unit_index = ?
  `).get(partId, unitIndex);
  if (!row) throw new Error(`No Required unit for part ${partId} index ${unitIndex}`);
  return row.token;
}

function unitReceipt(result) {
  if (result.kind === 'updated') return { status: 200, body: result.body };
  if (result.kind === 'stale_accepted_plan') {
    return { status: 409, body: { detail: 'Accepted Plan changed; reload and retry' } };
  }
  if (result.kind === 'unit_not_found') return { status: 404, body: { detail: 'Part unit not found' } };
  if (result.kind === 'plan_archived') {
    return { status: 409, body: { detail: 'Archived Plan Progress cannot be changed' } };
  }
  if (result.kind === 'transaction_unavailable') {
    return { status: 503, body: { detail: 'Accepted Plan update is unavailable' } };
  }
  if (result.kind === 'accepted_state_unavailable') {
    const detail = result.reason === 'compatibility_dirty'
      ? 'Accepted Plan requires compatibility repair'
      : 'Accepted Plan operational state is not initialized';
    return { status: 409, body: { detail } };
  }
  throw new Error(`Unexpected completion result ${JSON.stringify(result)}`);
}

function importReceipt(result) {
  if (result.kind === 'updated') return { status: 200, body: { updated_parts: result.updatedParts } };
  if (result.kind === 'stale_accepted_plan') {
    return { status: 409, body: { detail: 'Accepted Plan changed; reload and retry', code: 'stale_accepted_plan' } };
  }
  if (result.kind === 'part_not_found' || result.kind === 'unit_not_found') {
    return { status: 404, body: { detail: 'Plan or Part not found', code: 'progress_target_not_found' } };
  }
  if (result.kind === 'invalid_rows') {
    return { status: 422, body: { detail: 'Printed counts are invalid', code: 'invalid_rows' } };
  }
  if (result.kind === 'plan_archived') {
    return { status: 409, body: { detail: 'Archived Plan Progress cannot be changed', code: 'plan_archived' } };
  }
  if (result.kind === 'accepted_state_unavailable') {
    return { status: 409, body: { detail: 'Accepted Plan state is unavailable', code: 'accepted_state_unavailable' } };
  }
  if (result.kind === 'transaction_unavailable') {
    return { status: 503, body: { detail: 'Plan draft update is unavailable', code: 'transaction_unavailable' } };
  }
  throw new Error(`Unexpected import result ${JSON.stringify(result)}`);
}

const invalidImport = { status: 400, body: { detail: 'Request is invalid', code: 'invalid_request' } };

const output = [];
for (const { name, database, setup, calls } of cases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-checkoff-transactions-'));
  copyFileSync(join(root, database), join(directory, 'print-partner.db'));
  let raw = new DatabaseSync(join(directory, 'print-partner.db'));
  let ports;
  try {
    for (const sql of setup) raw.exec(sql);
    const read = () => ({
      units: raw.prepare(queries.units).all(),
      progress: raw.prepare(queries.progress).all(),
    });
    const before = read();
    assert.ok(before.progress.some((row) => row.completed === 1 && row.assembled === 1), `${name} starts from a recorded physical result`);
    assert.equal(before.units.length, before.progress.length, `${name} has one progress row per Required unit`);
    raw.close();
    ports = createSelfHostPorts(directory);
    await ports.db.connect();
    raw = new DatabaseSync(join(directory, 'print-partner.db'));
    const accepted = ports.repository.readAcceptedPlanOperationalSnapshot(1);
    if (accepted.kind !== 'ready') throw new Error(`${name} accepted state is ${accepted.kind}`);
    const basis = snakeBasis(accepted.snapshot);
    const steps = [];
    let reopenedAt = null;
    let previous = null;
    for (const call of calls) {
      if (call.op === 'reopen') {
        reopenedAt = steps.length;
        raw.close();
        await ports.db.close();
        ports = createSelfHostPorts(directory);
        await ports.db.connect();
        raw = new DatabaseSync(join(directory, 'print-partner.db'));
        continue;
      }
      const source = call.op === 'replay' ? previous.request : null;
      const kind = call.op === 'replay' ? previous.op : call.op === 'stale' ? call.kind : call.op;
      const expected = call.op === 'stale' ? { ...basis, plan_version: basis.plan_version + 1 } : basis;
      let request;
      let receipt;
      if (kind === 'complete') {
        const token = source ? source.token : tokenFor(raw, call.partId, call.unitIndex);
        const completed = source ? source.completed : call.completed;
        request = { expected, token, completed };
        receipt = unitReceipt(ports.repository.setAcceptedUnitCompletion({
          expected: {
            profileId: expected.profile_id,
            planVersion: expected.plan_version,
            revisionId: expected.plan_revision_id,
            revisionDigest: expected.plan_revision_digest,
            requiredUnitMappingDigest: expected.required_unit_mapping_digest,
          },
          token: parseRequiredUnitToken(token),
          completed,
        }));
      } else if (kind === 'import') {
        request = source ?? { expected, rows: call.rows };
        try {
          const parsed = parseAcceptedProgressImportRequest(request);
          receipt = importReceipt(ports.repository.setAcceptedPrintedCounts({
            expected: {
              profileId: parsed.expected.profile_id,
              planVersion: parsed.expected.plan_version,
              revisionId: parsed.expected.plan_revision_id,
              revisionDigest: parsed.expected.plan_revision_digest,
              requiredUnitMappingDigest: parsed.expected.required_unit_mapping_digest,
            },
            rows: parsed.rows.map((row) => ({ partId: row.part_id, printedCount: row.printed_count })),
          }));
        } catch (error) {
          if (!isPlanDraftContractError(error)) throw error;
          receipt = invalidImport;
        }
      } else {
        throw new Error(`Unknown call ${call.op}`);
      }
      const rows = read();
      rows.receipts = [receipt];
      const step = { op: kind, request, receipt, rows };
      if (call.op === 'replay') {
        assert.deepEqual(step.receipt, previous.receipt, `${name} replay receipt`);
        assert.deepEqual(step.rows, previous.rows, `${name} replay rows`);
      }
      if (call.op === 'import' && receipt.status !== 200 || call.op === 'stale') {
        assert.deepEqual(rows.units, previous.rows.units, `${name} refusal keeps Required units`);
        assert.deepEqual(rows.progress, previous.rows.progress, `${name} refusal keeps progress`);
        assert.equal(rows.receipts.length, 1);
      }
      assert.equal(rows.progress.length, before.progress.length, `${name} does not add a progress row`);
      assert.deepEqual(rows.units, before.units, `${name} does not add a Required unit`);
      steps.push(step);
      previous = step;
    }
    assert.notEqual(reopenedAt, null);
    assert.ok(before.progress.length > 0);
    output.push({ name, database, setup, reopenedAt, before, steps });
  } finally {
    raw.close();
    await ports?.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const path = join(here, 'node.json');
const line = (value) => JSON.stringify(value);
const bytes = `{"_generated": "@generated by fixtures/parity/checkoff-transactions/generate.mjs",\n"queries": ${line(queries)},\n"cases": [\n${output.map(({ steps, ...header }) =>
  `${line(header).slice(0, -1)}, "steps": [\n${steps.map(line).join(',\n')}\n]}`).join(',\n')}\n]}\n`;
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(path, 'utf8'), bytes, 'Checkoff transaction fixtures are stale');
  console.log('node.json matches the Node Checkoff transactions');
} else {
  writeFileSync(path, bytes);
  console.log(`Wrote ${output.length} Checkoff transaction cases to node.json`);
}

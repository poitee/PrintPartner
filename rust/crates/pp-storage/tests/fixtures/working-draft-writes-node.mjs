import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(process.argv[2]);
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const { PlanDraftWorkspaceService } = await import(join(server, 'src/services/plan-draft-workspace.ts'));
const { parseAbandonPlanDraftRequest, parseEditPlanDraftPartsRequest } = await import(join(server, '../../packages/contracts/src/index.ts'));

const stale = '0'.repeat(64);
const opened = 'ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3';
const include = (ids, value) => ({ kind: 'set_included', draft_part_ids: ids, value });
const quantity = (ids, value) => ({ kind: 'set_quantity_override', draft_part_ids: ids, value });
const edit = (draft, request, profile = 1) => ({ op: 'edit', profile, draft, request });
const abandon = (draft, version, profile = 1) => ({ op: 'abandon', profile, draft, request: { expected_lifecycle_version: version } });
const updated = edit(2, { expected_snapshot_digest: opened, decisions: [include([5], true), quantity([4], null)] });
const cases = [
  { name: 'edit-updated-and-retried', calls: [updated, updated] },
  { name: 'edit-unchanged-with-stale-digest', calls: [edit(2, { expected_snapshot_digest: stale, decisions: [include([4], true)] })] },
  { name: 'edit-conflict', calls: [edit(2, { expected_snapshot_digest: stale, decisions: [include([5], true)] })] },
  { name: 'edit-missing', calls: [
    edit(2, updated.request, 999),
    edit(999, updated.request),
    edit(2, { expected_snapshot_digest: opened, decisions: [include([1], false)] }),
    edit(2, { expected_snapshot_digest: opened, decisions: [include([5], true), quantity([4, 999], 2)] }),
  ] },
  { name: 'edit-consumed', calls: [edit(1, { expected_snapshot_digest: stale, decisions: [include([1], false)] })] },
  { name: 'edit-base-changed', setup: ['UPDATE build_profiles SET accepted_plan_version=2 WHERE id=1'], calls: [updated] },
  { name: 'edit-baseline-required', setup: ['UPDATE build_profiles SET accepted_plan_revision_id=NULL,accepted_plan_version=0 WHERE id=1'], calls: [updated] },
  { name: 'edit-selected', select: true, calls: [edit(2, { expected_snapshot_digest: '7aede566782b7712a7cc113a0706829a501ba98b2f3d9e6a5cd645ff20048f8f', decision: quantity([6], 7) })] },
  { name: 'abandon-retried-then-not-open', calls: [abandon(2, 0), abandon(2, 0), abandon(2, 1), edit(2, updated.request)] },
  { name: 'abandon-conflict', calls: [abandon(2, 3)] },
  { name: 'abandon-consumed', calls: [abandon(1, 1)] },
  { name: 'abandon-missing', calls: [abandon(2, 0, 999), abandon(999, 0), abandon(2, 2147483647, 999), abandon(2, 2147483647), abandon(999, 2147483647)] },
];

const output = [];
for (const { name, setup = [], select = false, calls } of cases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-draft-writes-node-'));
  copyFileSync(join(here, 'required-units', 'unchanged.db'), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  try {
    for (const sql of setup) raw.exec(sql);
    const service = new PlanDraftWorkspaceService(ports.repository);
    if (select) {
      const result = service.reconcile({ profileId: 1, draftId: 2, actorId: 'default', idempotencyKey: 'core-selection', request: { expected_snapshot_digest: opened, decisions: [] } });
      if (result.kind !== 'ready') throw new Error(JSON.stringify(result));
    }
    const results = calls.map(({ op, profile, draft, request }) => {
      try {
        return op === 'edit'
          ? service.editParts({ profileId: profile, draftId: draft, actorId: 'default', request: parseEditPlanDraftPartsRequest(request) })
          : service.abandon({ profileId: profile, draftId: draft, request: parseAbandonPlanDraftRequest(request) });
      } catch (error) {
        return { error: error.message };
      }
    });
    const rows = (sql) => raw.prepare(sql).all().map((row) => ({ ...row }));
    output.push({
      name, setup, select, calls, results,
      drafts: rows('SELECT id,state,lifecycle_version,digest_format,current_required_unit_reconciliation_id,snapshot_digest FROM plan_drafts ORDER BY id'),
      parts: rows('SELECT id,draft_id,included,quantity_override,quantity_effective FROM plan_draft_parts ORDER BY id'),
      reconciliations: rows('SELECT id,draft_id,actor_id,idempotency_key,planning_digest,result_kind,reconciliation_digest,payload_digest FROM plan_draft_required_unit_reconciliations ORDER BY id'),
      assignments: rows('SELECT reconciliation_id,target_draft_part_id,unit_index,kind,required_unit_token FROM plan_draft_required_unit_assignments ORDER BY reconciliation_id,target_draft_part_id,unit_index'),
    });
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const accepts = (parse, body) => {
  try {
    parse(JSON.parse(body));
    return true;
  } catch {
    return false;
  }
};
const many = (count) => Array.from({ length: count }, (_, index) => include([index + 1], true));
const editBodies = [
  { expected_snapshot_digest: opened, decision: include([4], false) },
  { expected_snapshot_digest: opened, decisions: [include([4], false), quantity([4], 2)] },
  { expected_snapshot_digest: opened, decisions: [] },
  { expected_snapshot_digest: opened, decisions: [include([4], false), include([4], true)] },
  { expected_snapshot_digest: opened, decisions: [include([4, 4], false)] },
  { expected_snapshot_digest: opened, decision: include([], false) },
  { expected_snapshot_digest: opened, decision: include([0], false) },
  { expected_snapshot_digest: opened, decision: include([9007199254740992], false) },
  { expected_snapshot_digest: opened, decision: quantity([4], 0) },
  { expected_snapshot_digest: opened, decision: quantity([4], 10_000) },
  { expected_snapshot_digest: opened, decision: quantity([4], 10_001) },
  { expected_snapshot_digest: opened, decision: quantity([4], 1.5) },
  { expected_snapshot_digest: opened, decision: { kind: 'set_quantity_override', draft_part_ids: [4] } },
  { expected_snapshot_digest: opened, decision: { ...include([4], false), extra: 1 } },
  { expected_snapshot_digest: opened, decision: { kind: 'set_notes', draft_part_ids: [4], value: 'x' } },
  { expected_snapshot_digest: opened, decision: include([4], 1) },
  { expected_snapshot_digest: opened, decision: include([4], false), extra: 1 },
  { expected_snapshot_digest: opened, decision: include([4], false), decisions: [include([5], false)] },
  { expected_snapshot_digest: opened, decision: null, decisions: [include([5], false)] },
  { expected_snapshot_digest: opened.toUpperCase(), decision: include([4], false) },
  { decision: include([4], false) },
].map(JSON.stringify);
const abandonBodies = [
  { expected_lifecycle_version: 0 },
  { expected_lifecycle_version: 9007199254740991 },
  { expected_lifecycle_version: 9007199254740992 },
  { expected_lifecycle_version: -1 },
  { expected_lifecycle_version: 1.5 },
  { expected_lifecycle_version: '1' },
  { expected_lifecycle_version: 0, extra: 1 },
  {},
].map(JSON.stringify);
output.push({
  name: 'contract',
  edit: editBodies.map((body) => ({ body, accepted: accepts(parseEditPlanDraftPartsRequest, body) })),
  batchLimit: [10_000, 10_001].map((count) => ({
    count,
    accepted: accepts(parseEditPlanDraftPartsRequest, JSON.stringify({ expected_snapshot_digest: opened, decisions: many(count) })),
  })),
  abandon: abandonBodies.map((body) => ({ body, accepted: accepts(parseAbandonPlanDraftRequest, body) })),
});
process.stdout.write(`${output.map((row) => JSON.stringify(row)).join('\n')}\n`);

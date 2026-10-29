import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(process.argv[2]);
process.env.PP_DESKTOP_REBUILD = '1';
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const { PlanDraftWorkspaceService } = await import(join(server, 'src/services/plan-draft-workspace.ts'));
const { parseEditPlanDraftPartsRequest } = await import(join(server, '../../packages/contracts/src/index.ts'));

const opened = 'ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3';
const files = ['bracket.stl', 'excluded.stl', 'gear.stl', 'new.stl'];
const recompute = (key, applyManifest = true, between = null, profile = 1) => ({ op: 'recompute', profile, key, applyManifest, between });
const selecting = (key) => ({ ...recompute(key), op: 'service' });
const reconcile = (draft, digest, key) => ({ op: 'reconcile', profile: 1, draft, digest, key });
const failSelection = "CREATE TRIGGER injected_selection_failure BEFORE INSERT ON plan_draft_required_unit_reconciliations BEGIN SELECT RAISE(ABORT,'injected selection write failure'); END";
const edited = { op: 'edit', profile: 1, draft: 2, request: { expected_snapshot_digest: opened, decisions: [
  { kind: 'set_included', draft_part_ids: [5], value: true },
  { kind: 'set_quantity_override', draft_part_ids: [6], value: 7 },
] } };
const copyDraft = (key, lineage = 'NULL,NULL,NULL') => [
  `INSERT INTO plan_drafts(id,tenant_id,profile_id,base_revision_id,base_plan_version,state,digest_format,snapshot_digest,created_by,idempotency_key,created_at,rebased_from_draft_id,rebased_from_lifecycle_version,rebased_from_snapshot_digest) SELECT 3,tenant_id,profile_id,base_revision_id,base_plan_version,'open',digest_format,snapshot_digest,created_by,'${key}',created_at,${lineage} FROM plan_drafts WHERE id=2`,
  'INSERT INTO plan_draft_inputs(tenant_id,draft_id,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest) SELECT tenant_id,3,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest FROM plan_draft_inputs WHERE draft_id=2',
  'INSERT INTO plan_draft_parts(tenant_id,draft_id,base_revision_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest) SELECT tenant_id,3,base_revision_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest FROM plan_draft_parts WHERE draft_id=2',
].join('; ');
// Stands in for an accepted revision published with curated choices on its first Part.
// The digest is Node's digestPlanRevisionParts over the curated Parts.
const curated = [
  'DROP TRIGGER trg_plan_revision_parts_immutable_update',
  'DROP TRIGGER trg_plan_revisions_immutable_update',
  "UPDATE plan_revision_parts SET role_override='accent',filament_color_id='color-7',filament_custom_hex='#ff8800',spoolman_spool_id='42',notes='curated by hand' WHERE id=1",
  "UPDATE plan_revisions SET snapshot_digest='962e1c1f53ada097c6cbfdd39dbffaa417812c1c0db5127244bec3f299df6cf5' WHERE id=1",
  // The legacy projection Part carries the same choices; its update trigger clears the accepted revision.
  "UPDATE parts SET role='accent',filament_color_id='color-7',filament_custom_hex='#ff8800',spoolman_spool_id='42',notes='curated by hand' WHERE id=1",
  'UPDATE build_profiles SET accepted_plan_revision_id=1 WHERE id=1',
].join('; ');
const rebased = `UPDATE plan_drafts SET state='abandoned',lifecycle_version=1 WHERE id=2; ${copyDraft('rebased', '2,1,snapshot_digest')}`;
const cases = [
  { name: 'created-then-replayed', calls: [recompute('first'), recompute(' \ufefffirst\n')] },
  { name: 'existing-recompute-key', calls: [recompute('working')] },
  { name: 'rebased-key-conflicts', setup: [rebased], calls: [recompute('rebased')] },
  { name: 'edits-carry-quantity', calls: [edited, recompute('first')] },
  { name: 'edits-carry-inclusion', calls: [edited, recompute('first', false)] },
  { name: 'accepted-overrides-survive-recompute', setup: [curated], calls: [recompute('first')] },
  { name: 'accepted-overrides-survive-kept-recompute', setup: [curated], calls: [recompute('first', false)] },
  { name: 'missing-profile-and-blank-key', calls: [recompute('first', true, null, 999), recompute(' \t\ufeff ')] },
  { name: 'baseline-required', setup: ['UPDATE build_profiles SET accepted_plan_revision_id=NULL,accepted_plan_version=0 WHERE id=1'], calls: [recompute('first')] },
  { name: 'baseline-required-after-prepare', calls: [recompute('first', true, 'UPDATE build_profiles SET accepted_plan_revision_id=NULL,accepted_plan_version=0 WHERE id=1')] },
  { name: 'base-moved-after-prepare', calls: [recompute('first', true, 'UPDATE build_profiles SET accepted_plan_version=2 WHERE id=1')] },
  { name: 'profile-hidden-after-prepare', calls: [recompute('first', true, "DROP TRIGGER trg_build_profiles_revision_ownership_update; UPDATE build_profiles SET tenant_id='foreign' WHERE id=1")] },
  { name: 'inputs-changed-after-prepare', calls: [recompute('first', true, `UPDATE source_revisions SET manifest_digest='${'b'.repeat(64)}' WHERE id=1`)] },
  { name: 'winner-after-prepare', calls: [recompute('first', true, copyDraft('first'))] },
  { name: 'no-layers', setup: ['DELETE FROM profile_layers'], calls: [recompute('first')] },
  { name: 'no-stls', files: [], calls: [recompute('first')] },
  { name: 'service-created-then-selected', calls: [selecting('first'), selecting('first')] },
  { name: 'service-existing-then-selected', calls: [selecting('working')] },
  { name: 'service-selection-fails-then-retried', setup: [failSelection], calls: [selecting('first'), { op: 'sql', sql: 'DROP TRIGGER injected_selection_failure' }, selecting('first')] },
  { name: 'service-existing-already-selected', calls: [reconcile(2, opened, 'core-selection'), selecting('working')] },
];

if (!process.argv.includes('--large-carry')) {
  const output = [];
  for (const { name, setup = [], files: stls = files, calls } of cases) {
    const directory = mkdtempSync(join(tmpdir(), 'pp-draft-recompute-node-'));
    copyFileSync(join(here, 'required-units', 'unchanged.db'), join(directory, 'print-partner.db'));
    const ports = createSelfHostPorts(directory);
    await ports.db.connect();
    const raw = new DatabaseSync(join(directory, 'print-partner.db'));
    try {
      const checkout = join(directory, 'checkout-1');
      for (const root of [checkout, join(directory, 'repos/1/revisions/fixture')]) {
        mkdirSync(root, { recursive: true });
        for (const path of stls) writeFileSync(join(root, path), path);
      }
      raw.prepare('UPDATE projects SET local_path=? WHERE id=1').run(checkout);
      for (const sql of setup) raw.exec(sql);
      const repo = ports.repository;
      const service = new PlanDraftWorkspaceService(repo);
      const prepare = repo.preparePlanDraft;
      const results = calls.map(({ op, profile, draft, request, key, applyManifest, between, digest, sql }) => {
        repo.preparePlanDraft = function (...args) {
          const prepared = prepare.apply(this, args);
          if (between) raw.exec(between);
          return prepared;
        };
        if (op === 'sql') {
          raw.exec(sql);
          return null;
        }
        try {
          if (op === 'service') return service.recompute({ profileId: profile, actorId: 'default', idempotencyKey: key, applyManifest });
          if (op === 'reconcile') return service.reconcile({ profileId: profile, draftId: draft, actorId: 'default', idempotencyKey: key, request: { expected_snapshot_digest: digest, decisions: [] } });
          if (op === 'edit') return service.editParts({ profileId: profile, draftId: draft, actorId: 'default', request: parseEditPlanDraftPartsRequest(request) });
          if (!repo.getOwnedProfileIdentity(profile)) return { kind: 'profile_not_found' };
          const result = repo.recomputePlanDraft({ profileId: profile, actor: 'default', idempotencyKey: key, applyManifest, preferAccepted: applyManifest === false });
          return result.draft ? { ...result, draft: { ...result.draft, createdAt: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.draft.createdAt) } } : result;
        } catch (error) {
          return { error: error.message };
        }
      });
      const rows = (sql) => raw.prepare(sql).all().map((row) => ({ ...row }));
      output.push({
        name, setup, files: stls, calls, results,
        drafts: rows("SELECT id,tenant_id,profile_id,base_revision_id,base_plan_version,state,lifecycle_version,rebased_from_draft_id,rebased_from_lifecycle_version,rebased_from_snapshot_digest,digest_format,snapshot_digest,created_by,idempotency_key,created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AS created_at_iso,current_required_unit_reconciliation_id,consumed_revision_id,consumed_at FROM plan_drafts ORDER BY id"),
        inputs: rows('SELECT * FROM plan_draft_inputs ORDER BY id'),
        parts: rows('SELECT * FROM plan_draft_parts ORDER BY id'),
        reconciliations: rows('SELECT id,draft_id,actor_id,idempotency_key,planning_digest,result_kind,reconciliation_digest,payload_digest FROM plan_draft_required_unit_reconciliations ORDER BY id'),
        assignments: rows('SELECT reconciliation_id,target_draft_part_id,unit_index,kind,required_unit_token FROM plan_draft_required_unit_assignments ORDER BY reconciliation_id,target_draft_part_id,unit_index'),
      });
    } finally {
      raw.close();
      await ports.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${output.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

if (process.argv.includes('--large-carry')) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-large-carry-node-'));
  copyFileSync(join(here, 'required-units/unchanged.db'), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  try {
    const checkout = join(directory, 'checkout');
    mkdirSync(checkout);
    for (let i = 0; i < 20; i += 1) {
      const filename = `old-${i.toString().padStart(4, '0')}.stl`;
      writeFileSync(join(checkout, filename), filename);
    }
    raw.prepare('UPDATE projects SET local_path=?,current_source_revision_id=NULL WHERE id=1').run(checkout);
    raw.exec("INSERT INTO build_profiles(id,tenant_id,name) VALUES(3,'default','New Build'); INSERT INTO profile_layers(tenant_id,profile_id,project_id,layer_type,layer_order) SELECT tenant_id,3,project_id,layer_type,layer_order FROM profile_layers WHERE profile_id=1");
    const service = new PlanDraftWorkspaceService(ports.repository);
    const first = service.recompute({ profileId: 3, actorId: 'default', idempotencyKey: 'node-large' });
    if (first.kind !== 'ready') throw new Error(`first outcome ${first.kind}`);
    const draft = ports.repository.getPlanDraft(3, first.workspace.draft.draft_id);
    if (!draft || draft.parts.length !== 20) throw new Error(`expected twenty real Source Parts: ${JSON.stringify(draft)}`);
    const edit = service.editParts({
      profileId: 3, draftId: draft.id, actorId: 'default',
      request: parseEditPlanDraftPartsRequest({ expected_snapshot_digest: draft.snapshotDigest, decision: { kind: 'set_quantity_override', draft_part_ids: draft.parts.map(part => part.id), value: 10000 } }),
    });
    if (edit.kind !== 'ready') throw new Error(`edit outcome ${edit.kind}`);
    const selected = raw.prepare("SELECT r.expected_assignment_count,(SELECT count(*) FROM plan_draft_required_unit_assignments a WHERE a.reconciliation_id=r.id) AS assignments,length(CAST(r.result_json AS BLOB)) AS result_bytes FROM plan_drafts d JOIN plan_draft_required_unit_reconciliations r ON r.id=d.current_required_unit_reconciliation_id WHERE d.profile_id=3 AND d.state='open'").get();
    if (selected.assignments !== 200000) throw new Error('expected 200,000 selected assignments');
    for (const filename of readdirSync(checkout)) unlinkSync(join(checkout, filename));
    writeFileSync(join(checkout, 'only-current.stl'), 'only-current.stl');
    const recomputed = service.recompute({ profileId: 3, actorId: 'default', idempotencyKey: 'node-small' });
    if (recomputed.kind !== 'ready') throw new Error(`recompute outcome ${recomputed.kind}`);
    const states = raw.prepare('SELECT state,lifecycle_version FROM plan_drafts WHERE profile_id=3 ORDER BY id').all();
    if (states.length !== 2 || states[0].state !== 'abandoned' || states[1].state !== 'open') throw new Error('wrong lifecycle');
    process.stdout.write(JSON.stringify({ first: first.kind, edit: edit.kind, selected, recompute: recomputed.kind, states, normal_service_path: true }) + '\n');
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

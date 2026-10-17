import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const edited = { op: 'edit', profile: 1, draft: 2, request: { expected_snapshot_digest: opened, decisions: [
  { kind: 'set_included', draft_part_ids: [5], value: true },
  { kind: 'set_quantity_override', draft_part_ids: [6], value: 7 },
] } };
const copyDraft = (key, lineage = 'NULL,NULL,NULL') => [
  `INSERT INTO plan_drafts(id,tenant_id,profile_id,base_revision_id,base_plan_version,state,digest_format,snapshot_digest,created_by,idempotency_key,created_at,rebased_from_draft_id,rebased_from_lifecycle_version,rebased_from_snapshot_digest) SELECT 3,tenant_id,profile_id,base_revision_id,base_plan_version,'open',digest_format,snapshot_digest,created_by,'${key}',created_at,${lineage} FROM plan_drafts WHERE id=2`,
  'INSERT INTO plan_draft_inputs(tenant_id,draft_id,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest) SELECT tenant_id,3,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest FROM plan_draft_inputs WHERE draft_id=2',
  'INSERT INTO plan_draft_parts(tenant_id,draft_id,base_revision_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest) SELECT tenant_id,3,base_revision_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest FROM plan_draft_parts WHERE draft_id=2',
].join('; ');
const rebased = `UPDATE plan_drafts SET state='abandoned',lifecycle_version=1 WHERE id=2; ${copyDraft('rebased', '2,1,snapshot_digest')}`;
const cases = [
  { name: 'created-then-replayed', calls: [recompute('first'), recompute(' \ufefffirst\n')] },
  { name: 'existing-recompute-key', calls: [recompute('working')] },
  { name: 'rebased-key-conflicts', setup: [rebased], calls: [recompute('rebased')] },
  { name: 'edits-carry-quantity', calls: [edited, recompute('first')] },
  { name: 'edits-carry-inclusion', calls: [edited, recompute('first', false)] },
  { name: 'missing-profile-and-blank-key', calls: [recompute('first', true, null, 999), recompute(' \t\ufeff ')] },
  { name: 'baseline-required', setup: ['UPDATE build_profiles SET accepted_plan_revision_id=NULL,accepted_plan_version=0 WHERE id=1'], calls: [recompute('first')] },
  { name: 'baseline-required-after-prepare', calls: [recompute('first', true, 'UPDATE build_profiles SET accepted_plan_revision_id=NULL,accepted_plan_version=0 WHERE id=1')] },
  { name: 'base-moved-after-prepare', calls: [recompute('first', true, 'UPDATE build_profiles SET accepted_plan_version=2 WHERE id=1')] },
  { name: 'profile-hidden-after-prepare', calls: [recompute('first', true, "DROP TRIGGER trg_build_profiles_revision_ownership_update; UPDATE build_profiles SET tenant_id='foreign' WHERE id=1")] },
  { name: 'inputs-changed-after-prepare', calls: [recompute('first', true, `UPDATE source_revisions SET manifest_digest='${'b'.repeat(64)}' WHERE id=1`)] },
  { name: 'winner-after-prepare', calls: [recompute('first', true, copyDraft('first'))] },
  { name: 'no-layers', setup: ['DELETE FROM profile_layers'], calls: [recompute('first')] },
  { name: 'no-stls', files: [], calls: [recompute('first')] },
];

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
    const results = calls.map(({ op, profile, draft, request, key, applyManifest, between }) => {
      repo.preparePlanDraft = function (...args) {
        const prepared = prepare.apply(this, args);
        if (between) raw.exec(between);
        return prepared;
      };
      try {
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
    });
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
process.stdout.write(`${output.map((row) => JSON.stringify(row)).join('\n')}\n`);

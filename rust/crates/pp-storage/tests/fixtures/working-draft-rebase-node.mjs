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
const { digestPlanDraft } = await import(join(server, 'src/services/plan-drafts.ts'));
const { parseEditPlanDraftPartsRequest, parseRebasePlanDraftRequest } = await import(join(server, '../../packages/contracts/src/index.ts'));

const opened = 'ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3';
// Requests naming `edits` expect the digest the preceding edit returned.
const edits = 'edits';
const files = ['bracket.stl', 'excluded.stl', 'gear.stl', 'new.stl'];
const rebase = (key, request, { profile = 1, draft = 2, between = null } = {}) => ({ op: 'rebase', profile, draft, key, request, between });
const open = (digest = opened, version = 0) => ({ expected_source_state: 'open', expected_source_lifecycle_version: version, expected_source_snapshot_digest: digest });
const abandoned = (digest = opened, version = 1) => ({ expected_source_lifecycle_version: version, expected_source_snapshot_digest: digest });
const edit = (...decisions) => ({ op: 'edit', profile: 1, draft: 2, request: { expected_snapshot_digest: opened, decisions } });
const edited = edit(
  { kind: 'set_included', draft_part_ids: [5], value: true },
  { kind: 'set_quantity_override', draft_part_ids: [6], value: 7 },
);
const movedInputs = `UPDATE source_revisions SET manifest_digest='${'b'.repeat(64)}' WHERE id=1`;
const movedBase = 'UPDATE build_profiles SET accepted_plan_version=2 WHERE id=1';
const cols = 'tenant_id,projection_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest';
// Revision 2 accepts gear.stl at quantity 9 and excludes bracket.stl.
const revised = [
  "INSERT INTO plan_revisions(id,tenant_id,profile_id,revision_number,parent_revision_id,input_set_id,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at) SELECT 2,tenant_id,profile_id,2,1,input_set_id,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at FROM plan_revisions WHERE id=1",
  `INSERT INTO plan_revision_parts(id,revision_id,${cols}) SELECT id+3,2,${cols.replace('quantity_override,quantity_effective,included', "CASE part_key WHEN 'gear.stl' THEN 9 ELSE quantity_override END,CASE part_key WHEN 'gear.stl' THEN 9 ELSE quantity_effective END,CASE part_key WHEN 'bracket.stl' THEN 0 ELSE included END")} FROM plan_revision_parts WHERE revision_id=1 ORDER BY id`,
  'UPDATE build_profiles SET accepted_plan_revision_id=2,accepted_plan_version=2 WHERE id=1',
].join('; ');
// Revision 2 also accepts new.stl, excluded.
const revisedWithNew = `${revised}; INSERT INTO plan_revision_parts(id,revision_id,${cols}) SELECT 7,2,${cols.replace('part_key,relative_path,filename', "'new.stl','new.stl','new.stl'").replace('included,', '0,')} FROM plan_revision_parts WHERE id=6`;
const addNew = "INSERT INTO plan_draft_parts(tenant_id,draft_id,base_revision_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest) SELECT tenant_id,draft_id,NULL,'new.stl','new.stl','new.stl',source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,NULL,quantity_inferred,1,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,NULL FROM plan_draft_parts WHERE id=6";
const abandon = "UPDATE plan_drafts SET state='abandoned',lifecycle_version=1 WHERE id=2";
const cases = [
  { name: 'base-unchanged', calls: [rebase('first', open())] },
  { name: 'source-checks', calls: [
    rebase('first', abandoned(opened, 0)),
    rebase('first', open('c'.repeat(64))),
    rebase('first', open(opened, 1)),
    rebase('first', open(), { draft: 99 }),
    rebase('first', open(), { profile: 999 }),
    rebase('first', open(), { draft: 1 }),
    rebase(' \t ', open()),
  ] },
  { name: 'version-bounds', calls: [rebase('first', open(opened, 2147483647)), rebase('first', abandoned(opened, 2147483648))] },
  { name: 'baseline-required', setup: ['UPDATE build_profiles SET accepted_plan_revision_id=NULL,accepted_plan_version=1 WHERE id=1'], calls: [rebase('first', open())] },
  { name: 'inputs-moved-open-edits', setup: [movedInputs], calls: [
    edited,
    rebase('first', open(edits)),
    rebase(' first\n', open(edits)),
    rebase('second', abandoned(edits)),
    rebase('third', abandoned()),
    rebase('first', open()),
  ] },
  { name: 'revised-base', calls: [edited, { op: 'sql', sql: revised }, rebase('first', open(edits))] },
  { name: 'revised-base-merges', calls: [edit({ kind: 'set_included', draft_part_ids: [4, 5], value: true }), { op: 'sql', sql: revised }, rebase('first', open(edits))] },
  { name: 'revised-base-new-part', setup: [addNew], reseal: true, calls: [{ op: 'sql', sql: revisedWithNew }, rebase('first', open('resealed'))] },
  { name: 'revised-base-agrees', calls: [{ op: 'sql', sql: revised }, rebase('first', open())] },
  { name: 'base-moved-abandoned', setup: [movedBase, abandon], calls: [rebase('first', abandoned())] },
  { name: 'key-of-a-recompute', setup: [movedBase], calls: [rebase('working', open())] },
  { name: 'inputs-moved-abandoned', setup: [movedInputs, abandon], calls: [rebase('first', abandoned())] },
  { name: 'base-moved-after-prepare', setup: [movedBase], calls: [rebase('first', open(), { between: 'UPDATE build_profiles SET accepted_plan_version=3 WHERE id=1' })] },
  { name: 'inputs-moved-after-prepare', setup: [movedBase], calls: [rebase('first', open(), { between: movedInputs })] },
  { name: 'source-abandoned-after-prepare', setup: [movedBase], calls: [rebase('first', open(), { between: abandon })] },
  { name: 'shared-layer', setup: [movedBase, "INSERT INTO projects(id,tenant_id,name,url) VALUES(2,'default','Twin','https://example.invalid/twin')", "INSERT INTO plan_draft_inputs(tenant_id,draft_id,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest) SELECT tenant_id,draft_id,2,source_layer,1,'untracked',NULL,NULL,effective_naming_digest FROM plan_draft_inputs WHERE draft_id=2", 'UPDATE plan_draft_parts SET quantity_override=4 WHERE id=6'], reseal: true, calls: [rebase('first', open('resealed'))] },
  { name: 'duplicate-key', setup: [movedBase, "INSERT INTO plan_draft_parts(tenant_id,draft_id,base_revision_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest) SELECT tenant_id,draft_id,NULL,part_key,'copy/'||relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,5,5,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest FROM plan_draft_parts WHERE id=6", 'UPDATE plan_draft_parts SET quantity_override=4,quantity_effective=4 WHERE id=6'], reseal: true, calls: [rebase('first', open('resealed'))] },
  { name: 'no-layers', setup: [movedBase, 'DELETE FROM profile_layers'], calls: [rebase('first', open())] },
  { name: 'no-stls', files: [], setup: [movedBase], calls: [rebase('first', open())] },
];

const output = [];
for (const { name, setup: given = [], reseal = false, files: stls = files, calls: planned } of cases) {
  let calls = [...planned];
  const setup = [...given];
  const directory = mkdtempSync(join(tmpdir(), 'pp-draft-rebase-node-'));
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
    if (reseal) {
      // Node refuses a draft whose rows no longer match its digest, so the
      // edited source draft gets the digest Node computes for its rows.
      const camel = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_(.)/g, (_, c) => c.toUpperCase()), value]));
      const header = camel(raw.prepare('SELECT * FROM plan_drafts WHERE id=2').get());
      const inputs = raw.prepare('SELECT * FROM plan_draft_inputs WHERE draft_id=2 ORDER BY id').all().map(camel);
      const parts = raw.prepare('SELECT * FROM plan_draft_parts WHERE draft_id=2 ORDER BY id').all().map(camel)
        .map((part) => ({ ...part, included: part.included === 1, geometrySame: part.geometrySame == null ? null : part.geometrySame === 1 }));
      const sql = `UPDATE plan_drafts SET snapshot_digest='${digestPlanDraft({ ...header, inputs, parts })}' WHERE id=2`;
      raw.exec(sql);
      setup.push(sql);
      const digest = sql.match(/'([0-9a-f]{64})'/)[1];
      calls = calls.map((call) => call.request?.expected_source_snapshot_digest === 'resealed'
        ? { ...call, request: { ...call.request, expected_source_snapshot_digest: digest } }
        : call);
    }
    const repo = ports.repository;
    const service = new PlanDraftWorkspaceService(repo);
    const prepare = repo.preparePlanDraft;
    let edits = null;
    const results = calls.map((call, index) => {
      if (call.request?.expected_source_snapshot_digest === 'edits') {
        calls[index] = call = { ...call, request: { ...call.request, expected_source_snapshot_digest: edits } };
      }
      const { op, profile, draft, request, key, between, sql } = call;
      repo.preparePlanDraft = function (...args) {
        const prepared = prepare.apply(this, args);
        if (between) raw.exec(between);
        return prepared;
      };
      try {
        if (op === 'sql') return raw.exec(sql) ?? null;
        if (op === 'edit') {
          const result = service.editParts({ profileId: profile, draftId: draft, actorId: 'default', request: parseEditPlanDraftPartsRequest(request) });
          edits = result.workspace?.draft.snapshot_digest;
          return result;
        }
        if (!repo.getOwnedProfileIdentity(profile)) return { kind: 'profile_not_found' };
        const parsed = parseRebasePlanDraftRequest(request);
        const result = repo.rebasePlanDraft({
          profileId: profile,
          sourceDraftId: draft,
          expectedSourceState: parsed.expected_source_state,
          expectedSourceLifecycleVersion: parsed.expected_source_lifecycle_version,
          expectedSourceSnapshotDigest: parsed.expected_source_snapshot_digest,
          actor: 'default',
          idempotencyKey: key,
        });
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

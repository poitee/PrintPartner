import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(process.argv[2]);
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const { PlanDraftWorkspaceService } = await import(join(server, 'src/services/plan-draft-workspace.ts'));
const { digestPlanDraft, diffPlanDraftSnapshot } = await import(join(server, 'src/services/plan-drafts.ts'));
const output = [];
for (const name of ['unchanged', 'list-order', 'legacy-input', 'shrink', 'unsafe', 'selected', 'rebase-origin', 'empty', 'diff', 'utf16']) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-draft-core-node-'));
  const fixture = ['shrink', 'unsafe'].includes(name) ? name : 'unchanged';
  copyFileSync(join(here, 'required-units', `${fixture}.db`), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  const setup = [];
  const apply = (sql, ...params) => {
    raw.prepare(sql).run(...params);
    setup.push({ sql, params });
  };
  try {
    const repo = ports.repository;
    const service = new PlanDraftWorkspaceService(repo);
    let draft = repo.getPlanDraft(1, 2);
    if (name === 'list-order') apply("UPDATE plan_drafts SET created_at='2000-01-01T00:00:00.000Z' WHERE id=2");
    if (name === 'legacy-input') {
      apply("UPDATE plan_revision_inputs SET tracking_kind='revision',effective_naming_digest=NULL WHERE input_set_id=1");
      apply("INSERT INTO plan_revision_inputs (tenant_id,input_set_id,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest) SELECT tenant_id,input_set_id,source_id,'legacy-last',-1,tracking_kind,source_revision_id,manifest_digest,NULL FROM plan_revision_inputs WHERE id=1");
    }
    if (name === 'selected') {
      const result = service.reconcile({ profileId: 1, draftId: 2, actorId: 'default', idempotencyKey: 'core-selection', request: { expected_snapshot_digest: draft.snapshotDigest, decisions: [] } });
      if (result.kind !== 'ready') throw new Error(JSON.stringify(result));
    }
    if (name === 'rebase-origin') {
      apply('DROP TRIGGER trg_plan_drafts_lineage_immutable');
      apply('UPDATE plan_drafts SET rebased_from_draft_id=1,rebased_from_lifecycle_version=0,rebased_from_snapshot_digest=? WHERE id=2', repo.getPlanDraft(1, 1).snapshotDigest);
    }
    if (['empty', 'diff', 'utf16'].includes(name)) {
      const inputFields = ['sourceId', 'sourceLayer', 'layerOrder', 'trackingKind', 'sourceRevisionId', 'manifestDigest', 'effectiveNamingDigest'];
      const partFields = Object.keys(draft.parts[0]).filter(key => !['id', 'draftId', 'baseRevisionPartId'].includes(key));
      const baseInputs = raw.prepare('SELECT * FROM plan_revision_inputs WHERE input_set_id=1').all().map(row => Object.fromEntries(inputFields.map(key => [key, row[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)] ?? (key === 'effectiveNamingDigest' ? '' : null)])));
      const accepted = repo.getAcceptedPlanRevision(1);
      const baseParts = accepted.parts.map(part => Object.fromEntries(['id', ...partFields].map(key => [key, part[key]])));
      if (name === 'empty') {
        apply('DROP TRIGGER trg_plan_drafts_identity_immutable');
        draft = { ...draft, baseRevisionId: null, basePlanVersion: 0, inputs: [], parts: [] };
      } else if (name === 'diff') {
        const source = raw.prepare('SELECT * FROM projects WHERE id=1').get();
        for (const id of [2, 3, 4]) {
          const row = { ...source, id, name: `Source ${id}`, url: `https://example.test/${id}` };
          apply(`INSERT INTO projects (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row));
        }
        const input = { sourceId: 2, sourceLayer: 'addon:Removed', layerOrder: -2, trackingKind: 'untracked', sourceRevisionId: null, manifestDigest: null, effectiveNamingDigest: '' };
        const columns = inputFields.map(key => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`));
        apply(`INSERT INTO plan_revision_inputs (tenant_id,input_set_id,${columns.join(',')}) VALUES ('default',1,${columns.map(() => '?').join(',')})`, ...Object.values(input));
        baseInputs.push(input);
        const basePart = raw.prepare('SELECT * FROM plan_revision_parts WHERE id=1').get();
        for (const id of [9, 10]) {
          const row = { ...basePart, id, projection_part_id: null, part_key: `removed-${id}.stl`, relative_path: `removed-${id}.stl`, filename: `removed-${id}.stl` };
          apply(`INSERT INTO plan_revision_parts (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row));
        }
        draft.inputs = [
          { ...draft.inputs[0], layerOrder: 2, effectiveNamingDigest: 'changed' },
          ...[4, 3].map(id => ({ id: 100 + id, draftId: 2, sourceId: id, sourceLayer: `addon:${id}`, layerOrder: -1, trackingKind: 'untracked', sourceRevisionId: null, manifestDigest: null, effectiveNamingDigest: '' })),
        ].sort((a, b) => a.layerOrder - b.layerOrder || a.sourceId - b.sourceId);
        draft.parts = [
          { ...draft.parts[0], baseRevisionPartId: null },
          { ...draft.parts[1], id: 11, notes: 'changed' },
          { ...draft.parts[2], quantityOverride: 3, quantityEffective: 3, requirement: 'optional', optionGroupId: 'group', manifestSource: 'manifest.yaml', geometrySame: false, notes: 'quote"\n雪' },
          ...[9, 10].map(id => ({ ...draft.parts[0], id, baseRevisionPartId: null, filename: `${id}.stl`, partKey: `${id}.stl`, relativePath: `${id}.stl` })),
        ];
      } else {
        draft.parts[2].requirement = '\ud800';
        draft.parts[2].optionGroupId = 'x\udfff';
      }
      apply('DELETE FROM plan_draft_inputs WHERE draft_id=2');
      apply('DELETE FROM plan_draft_parts WHERE draft_id=2');
      const insert = (table, row) => {
        const keys = Object.keys(row);
        const values = keys.map(key => typeof row[key] === 'boolean' ? Number(row[key]) : row[key]);
        const placeholders = values.map((value, index) => {
          if (typeof value !== 'string' || value.isWellFormed()) return '?';
          const units = Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
          const blob = Buffer.alloc(9 + units.length * 2);
          blob.set([0x50, 0x50, 0x4a, 0x53, 1]);
          blob.writeUInt32BE(units.length, 5);
          units.forEach((unit, i) => blob.writeUInt16BE(unit, 9 + i * 2));
          values[index] = undefined;
          return `X'${blob.toString('hex')}'`;
        });
        apply(`INSERT INTO ${table} (tenant_id,${keys.map(key => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)).join(',')}) VALUES ('default',${placeholders.join(',')})`, ...values.filter(value => value !== undefined));
      };
      draft.inputs.forEach(row => insert('plan_draft_inputs', row));
      draft.parts.forEach(row => insert('plan_draft_parts', row));
      draft.snapshotDigest = digestPlanDraft(draft);
      apply('UPDATE plan_drafts SET base_revision_id=?,base_plan_version=?,snapshot_digest=? WHERE id=2', draft.baseRevisionId, draft.basePlanVersion, draft.snapshotDigest);
      if (name === 'utf16') {
        output.push({ name, fixture, setup, list: JSON.stringify(repo.listPlanDraftIdentities(1)), read: JSON.stringify(draft), diff: JSON.stringify(diffPlanDraftSnapshot({ draft, baseInputs, baseParts, baseIsCurrent: true })), workspace: null });
        continue;
      }
    }
    output.push({ name, fixture, setup, list: JSON.stringify(repo.listPlanDraftIdentities(1)), read: JSON.stringify(repo.getPlanDraft(1, 2)), diff: JSON.stringify(repo.diffPlanDraft(1, 2)), workspace: JSON.stringify(service.read(1, 2).workspace), consumed: name === 'unchanged' ? JSON.stringify(repo.getPlanDraft(1, 1)) : null, ...(name === 'unchanged' ? { notFound: { list: service.list(999), profile: service.read(999, 2).kind, draft: service.read(1, 999).kind } } : {}) });
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
process.stdout.write(`${output.map(row => JSON.stringify(row)).join('\n')}\n`);

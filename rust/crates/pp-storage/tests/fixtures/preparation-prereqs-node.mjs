import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(process.argv[2]);
const { applyManifestToDraftParts, loadManifestYaml } = await import(join(server, 'src/services/manifest-apply.ts'));
const { loadKitManifest } = await import(join(server, 'src/services/kit-manifest-store.ts'));
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const part = (partKey, included = true, sourceLayer = '0:Frame', optionGroupId = null) => ({
  partKey, included, sourceLayer, optionGroupId, requirement: null, manifestSource: null,
});
const variant = (id, parts, excludes = []) => ({ id, parts, excludes });
const group = (variants, extra = {}) => ({ rule: 'pick_one', variants, parts: [], ...extra });
const doc = (name, value) => ({ name, yaml: JSON.stringify(value) });
const tool = { tool: group([variant('a', ['a.stl']), variant('b', ['b.stl'], ['common.stl'])]) };
const applyCases = [
  { name: 'first-rule-and-project-filter', docs: [
    doc('Other', { project: 'Other', parts: [{ match: '*.stl', requirement: 'wrong' }] }),
    doc('Frame', { project: 'Alias', parts: [{ match: 'a.stl', requirement: 'optional', option_group: 'explicit' }, { match: '*.stl', requirement: 'required', default_included: false }] }),
  ], parts: [part('a.stl'), part('b.stl'), part('a.stl', true, '0:Other'), part('a.stl', false, 'unlabelled')] },
  { name: 'manifest-default-and-kit-precedence', docs: [
    doc('Frame', { option_groups: tool, selections: { tool: 'a' } }),
    doc('Frame', { selections: { tool: 'b' } }),
  ], raw: '{"selections":{"tool":"b"}}', parts: [part('a.stl'), part('b.stl', false), part('common.stl'), part('plain.stl', false)] },
  { name: 'defaults-when-kit-invalid', docs: [doc('Frame', { option_groups: tool, selections: { tool: 'a' } })], raw: '{"name":4,"selections":{"tool":"b"}}', parts: [part('a.stl', false), part('b.stl')] },
  { name: 'explicit-empty-blocks-default', docs: [doc('Frame', { option_groups: tool, selections: { tool: 'a' } })], raw: '{"selections":{"tool":[]}}', parts: [part('a.stl'), part('b.stl')] },
  { name: 'merged-groups-and-inferred-precedence', docs: [
    doc('Frame', { option_groups: { tool: group([variant('a', ['a.stl'])], { rule: 'pick_n', min: 1, max: 2 }) }, selections: { tool: ['a', 'b'] } }),
    doc('Frame', { option_groups: { tool: group([variant('b', ['b.stl'])]) } }),
  ], groups: { tool: group([variant('a', ['extra.stl'], ['excluded.stl'])]) }, parts: ['a.stl', 'b.stl', 'extra.stl', 'excluded.stl'].map(p => part(p)) },
  { name: 'unknown-selection-and-minimum', docs: [doc('Frame', { option_groups: { tool: group([variant('a', ['a.stl'])], { min: 1 }) } })], raw: '{"selections":{"tool":"unknown"}}', parts: [part('a.stl'), part('unrelated.stl')] },
  { name: 'below-minimum-is-incomplete', docs: [doc('Frame', { option_groups: { tool: group([variant('a', ['a.stl']), variant('b', ['b.stl'])], { rule: 'pick_n', min: 2, max: 2 }) } })], raw: '{"selections":{"tool":"a"}}', parts: [part('a.stl'), part('b.stl')] },
  { name: 'kit-over-maximum-is-incomplete', docs: [doc('Frame', { option_groups: tool })], raw: '{"selections":{"tool":["a","b"]}}', parts: [part('a.stl'), part('b.stl')] },
  { name: 'explicit-membership-and-exclusion-scope', docs: [doc('Frame', { option_groups: tool, selections: { tool: 'b' } })], parts: [part('b.stl', true, '0:Frame', 'other'), part('common.stl', true, '0:Frame', 'other'), part('common.stl'), part('a.stl', true, '0:Frame', 'tool')] },
  { name: 'no-variants-selection-is-a-pattern', docs: [doc('Frame', { option_groups: { free: group([], { parts: ['*.stl'] }) }, selections: { free: 'a?.stl' } })], parts: [part('folder/a1.stl', false), part('b.stl'), part('plain.txt')] },
  { name: 'addon-rules-and-basename', docs: [doc('Frame', { addons: [{ parts: [{ match: 'A?.STL', requirement: 'optional' }] }] })], parts: [part('folder/a1.stl'), part('b.stl')] },
];
const output = [];
for (const test of applyCases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-prep-manifests-'));
  try {
    const sources = test.docs.map(({ name, yaml }, index) => {
      const localPath = join(directory, String(index));
      mkdirSync(localPath);
      writeFileSync(join(localPath, 'print-partner.manifest.yaml'), yaml);
      return { name, localPath };
    });
    const repo = {
      getProfileLayers: () => sources.map((_, index) => ({ project_id: index + 1 })),
      getProjectRow: id => sources[id - 1],
      getSetting: () => test.raw ?? null,
    };
    output.push({ kind: 'apply', ...test, result: applyManifestToDraftParts(repo, 1, test.parts, test.groups) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
for (const raw of [null, '', '{', '[]', 'null', '{}', '{"selections":{"2":" b ","a":[" x ","y"],"1":"z","empty":[]}}', '{"selections":{"tool":["a","a"]}}', '{"selections":{" ":"a"}}', '{"selections":{"tool":4}}', '{"layers":[4],"selections":{"tool":"a"}}', '{"selections":{"\\ud800":"\\udc00"}}', '{"unknown":{"deep":[1,2]},"selections":{"tool":"a"}}']) {
  const selections = loadKitManifest({ getSetting: () => raw }, 1).selections;
  output.push({ kind: 'kit', raw, result: JSON.stringify(Object.entries(selections).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])) });
}
for (const yaml of [null, '', '{', '[]', 'null', 'project: Frame\nparts: [a.stl]', 'option_groups: { x: { rule: invalid } }', 'selections: { x: [] }']) {
  let result = null;
  try {
    if (yaml !== null) {
      const parsed = loadManifestYaml(yaml);
      result = { project: parsed.project ?? null, rules: parsed.parts.length + parsed.addons.flatMap(a => a.parts).length };
    }
  } catch {}
  output.push({ kind: 'optional', yaml, result });
}
const reuseCases = [
  ['current', ''],
  ['configuration-stale', "UPDATE build_profiles SET config_modified_at='2099-01-01T00:00:00.000Z'"],
  ['untracked', 'DELETE FROM plan_accepted_input_sets'],
  ['source-untracked', 'UPDATE projects SET current_source_revision_id=NULL'],
  ['source-unavailable', 'UPDATE projects SET current_source_revision_id=999'],
  ['naming-stale', "INSERT OR REPLACE INTO app_settings(tenant_id,key,value) VALUES('default','stl_naming_defaults','{\"roles\":[{\"id\":\"primary\",\"label\":\"Primary\",\"markers\":[]},{\"id\":\"accent\",\"label\":\"Accent\",\"markers\":[]},{\"id\":\"clear\",\"label\":\"Clear\",\"markers\":[]},{\"id\":\"opaque\",\"label\":\"Opaque\",\"markers\":[]}],\"quantity\":{\"regex\":\"[ _]x([0-9]+)\\\\.stl$\",\"default\":1},\"slug\":{\"strip_markers\":true,\"strip_quantity\":false},\"folder_rules\":[],\"export_role_order\":[\"primary\",\"accent\",\"clear\",\"opaque\"]}')"],
  ['projection-corrupt', "UPDATE parts SET notes='corrupt' WHERE id=1"],
  ['revision-corrupt', "UPDATE plan_revisions SET snapshot_digest='corrupt' WHERE id=1"],
];
for (const [name, sql] of reuseCases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-prep-reuse-'));
  copyFileSync(join(here, 'accepted-plan-node.db'), join(directory, 'print-partner.db'));
  mkdirSync(join(directory, 'repos/1/revisions/accepted'), { recursive: true });
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  raw.exec('PRAGMA foreign_keys=OFF');
  try {
    for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) raw.exec(`DROP TRIGGER "${name}"`);
    if (sql) raw.exec(sql);
    const naming = ports.repository.getSourceNaming(1).settings;
    const current = ports.repository.getProfileHeader(1).freshness.status === 'current';
    try {
      const accepted = current ? ports.repository.readAcceptedPlanOperationalSnapshot(1) : null;
      output.push({ kind: 'reuse', name, sql, naming, current, acceptedKind: accepted?.kind ?? null, reusable: current && accepted.kind === 'ready' });
    } catch (error) {
      output.push({ kind: 'reuse', name, sql, naming, current, acceptedKind: 'integrity_failure', errorCode: error.code, errorMessage: error.message });
    }
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
process.stdout.write(`${output.map(row => JSON.stringify(row)).join('\n')}\n`);

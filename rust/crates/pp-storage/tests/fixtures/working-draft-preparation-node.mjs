import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(process.argv[2]);
process.env.PP_DESKTOP_REBUILD = '1';
const { createSelfHostPorts } = await import(join(server, 'src/adapters/self-host/index.ts'));
const files = ['gear.stl', '[a]clip_x3.stl', 'folder/bracket.stl', 'included.stl', 'excluded.stl'].map(path => ({ source: 1, path, content: path }));
const manifest = JSON.stringify({ parts: [{ match: 'gear.stl', requirement: 'optional' }], option_groups: { tool: { rule: 'pick_one', variants: [{ id: 'a', parts: ['gear.stl'] }, { id: 'b', parts: ['folder/bracket.stl'] }] } }, selections: { tool: 'a' } });
const priorManifest = JSON.stringify({ option_groups: { tool: { rule: 'pick_one', variants: [{ id: 'a', parts: ['included.stl'] }, { id: 'b', parts: ['excluded.stl'] }] } }, selections: { tool: 'b' } });
const setting = (key, value) => `INSERT OR REPLACE INTO app_settings(tenant_id,key,value) VALUES('default','${key}','${JSON.stringify(value).replaceAll("'", "''")}')`;
const spoolDefaults = { primary: { filament_color_id: 'spoolman:17', spoolman_spool_id: '17', filament_custom_hex: '#abcdef' } };
const naming = { roles: [{ id: 'primary', label: 'Primary', markers: [] }, { id: 'accent', label: 'Accent', markers: ['[a]', '[accent]'] }, { id: 'clear', label: 'Clear', markers: [] }, { id: 'opaque', label: 'Opaque', markers: [] }], quantity: { regex: '[ _]x([0-9]+)\\.stl$', default: 1 }, slug: { strip_markers: true, strip_quantity: true }, folder_rules: [{ path_contains: 'clear', role_id: 'clear' }], export_role_order: ['primary', 'accent', 'clear', 'opaque'] };
const cases = [
  { name: 'spoolman-default-disabled', files, sql: setting('role_filaments_1', spoolDefaults) },
  { name: 'spoolman-user-enabled', files, sql: `${setting('role_filaments_1', spoolDefaults)}; ${setting('feature_toggles', { spoolman: true })}` },
  { name: 'spoolman-plan-disabled', files, sql: `${setting('role_filaments_1', spoolDefaults)}; ${setting('feature_toggles', { spoolman: true })}; ${setting('feature_toggles:plan:1', { spoolman: false })}` },
  { name: 'spoolman-plan-enabled', files, sql: `${setting('role_filaments_1', spoolDefaults)}; ${setting('feature_toggles', { spoolman: false })}; ${setting('feature_toggles:plan:1', { spoolman: true })}` },
  { name: 'spoolman-invalid-denies', files, sql: `${setting('role_filaments_1', spoolDefaults)}; ${setting('feature_toggles', { spoolman: 1 })}` },
  { name: 'naming-folder-and-longest-marker', files: ['clear/[accent]part_x3.stl', '[accent]part_x2.stl', 'part_x9.stl'].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', naming) },
  { name: 'naming-first-quantity-anchor', files: ['barfoo.stl', 'x/bar.stl'].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', { ...naming, quantity: { ...naming.quantity, regex: '_x([0-9]+)\\.stl$|foo\\.stl$' } }) },
  { name: 'naming-wildcard-extension', files: ["partx2astl.stl", "x/part.stl"].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', { ...naming, quantity: { ...naming.quantity, regex: "x([0-9]+)astl" } }) },
  { name: 'naming-uppercase-escaped-extension', files: ["partX2.STL", "x/part.stl"].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', { ...naming, quantity: { ...naming.quantity, regex: "X([0-9]+)\\.STL$" } }) },
  { name: 'naming-python-named-group', files: ["part2.stl", "x/part.stl"].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', { ...naming, quantity: { ...naming.quantity, regex: "(?P<n>[0-9]+)\\.stl$" } }) },
  { name: 'naming-noncapturing-before-capture', files: ["part_x2.stl", "x/part.stl"].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', { ...naming, quantity: { ...naming.quantity, regex: "(?:_x)([0-9]+)\\.stl$" } }) },
  { name: 'naming-bom-trim', files: ["part_x2.stl", "x/part.stl"].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', { ...naming, quantity: { ...naming.quantity, regex: "\ufeff_x([0-9]+)\\.stl$\ufeff" } }) },
  { name: 'naming-uppercase-extension-at-strip-end', files: ['partX2.STL', 'x/part.stl'].map(path => ({ source: 1, path, content: path })), sql: setting('stl_naming_defaults', { ...naming, quantity: { ...naming.quantity, regex: 'X([0-9]+)\\.STL' } }) },
  { name: 'tracked', files },
  { name: 'untracked', files, sql: 'UPDATE projects SET current_source_revision_id=NULL' },
  { name: 'prior-decisions', files, base: { baseRevisionId: 1, basePlanVersion: 1 }, sql: "UPDATE plan_revision_parts SET included=0,quantity_override=7,quantity_effective=7,role_override='clear',notes='keep',filament_custom_hex='#abcdef' WHERE part_key='included.stl'" },
  { name: 'layer-winners-and-conflicts', files: [...files, { source: 2, path: 'gear.stl', content: 'replacement' }, { source: 2, path: 'other/gear.stl', content: 'conflict' }], second: true },
  { name: 'import-filter', files, sql: `UPDATE projects SET imported_paths='["folder"]'` },
  { name: 'import-double-slash', files, sql: `UPDATE projects SET imported_paths='["folder//"]'` },
  { name: 'role-defaults', files, sql: `INSERT OR REPLACE INTO app_settings(tenant_id,key,value) VALUES('default','role_filaments_1','{"primary":{"filament_color_id":"red","filament_custom_hex":"#ff0000"}}')` },
  { name: 'invalid-import-filter', files, sql: `UPDATE projects SET imported_paths='{'` },
  { name: 'path-scopes', files, options: { included: { 1: ['folder/**', 'gear.stl'] }, excluded: { 1: ['gear.stl'] } } },
  { name: 'manifest', files, docs: { 1: manifest } },
  { name: 'kit-selection', files, docs: { 1: manifest }, sql: `INSERT OR REPLACE INTO app_settings(tenant_id,key,value) VALUES('default','kit_manifest_1','{"selections":{"tool":"b"}}')` },
  { name: 'apply-manifest-to-prior', files, docs: { 1: priorManifest }, base: { baseRevisionId: 1, basePlanVersion: 1 } },
  { name: 'preserve-inclusion', files, docs: { 1: priorManifest }, base: { baseRevisionId: 1, basePlanVersion: 1 }, options: { applyManifest: false } },
  { name: 'invalid-optional', files, docs: { 1: '{' } },
  { name: 'inferred-siblings', files: [{ source: 1, path: 'Options/Tool/A/mount.stl', content: 'a' }, { source: 1, path: 'Options/Tool/B/mount.stl', content: 'b' }] },
  { name: 'custom-hints', files, hints: JSON.stringify({ version: 1, rules: [{ path: 'gear.stl', option_group: 'tool', variant_id: 'gear' }] }), sql: `INSERT OR REPLACE INTO app_settings(tenant_id,key,value) VALUES('default','kit_manifest_1','{"selections":{"tool":"gear"}}')` },
  { name: 'choices', files, options: { choices: { 1: { 'gear.stl': { role: 'opaque', color: '#123456', quantity: 4 } } } } },
  { name: 'missing-choice', files, options: { choices: { 1: { 'missing.stl': { role: 'primary', color: null, quantity: 2 } } } } },
  { name: 'reuse', files: [], base: { baseRevisionId: 1, basePlanVersion: 1 }, options: { applyManifest: false, preferAccepted: true } },
  { name: 'reuse-with-scope-is-disabled', files, base: { baseRevisionId: 1, basePlanVersion: 1 }, options: { applyManifest: false, preferAccepted: true, excluded: {} } },
  { name: 'no-layers', files, sql: 'DELETE FROM profile_layers' },
  { name: 'no-root', files, sql: 'UPDATE projects SET current_source_revision_id=NULL,local_path=NULL' },
  { name: 'no-stls', files: [] },
  { name: 'capture-tracked', capture: true, files: [] },
  { name: 'capture-untracked', capture: true, files: [], sql: `UPDATE projects SET current_source_revision_id=NULL,local_path='/logical/checkout',imported_paths='[" /folder ","a.stl"]'` },
  { name: 'duplicate-source', capture: true, files: [], sql: "INSERT INTO profile_layers(tenant_id,profile_id,layer_order,layer_type,project_id) VALUES('default',1,1,'addon',1)" },
  { name: 'foreign-revision', capture: true, files: [], second: true, sql: 'UPDATE projects SET current_source_revision_id=1 WHERE id=2' },
  { name: 'missing-revision', capture: true, files: [], sql: 'UPDATE projects SET current_source_revision_id=999' },
];
const output = [];
for (const test of cases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-preparation-node-'));
  copyFileSync(join(here, 'accepted-plan-node.db'), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  raw.exec('PRAGMA foreign_keys=OFF');
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) raw.exec(`DROP TRIGGER "${name}"`);
  const setup = [];
  const apply = sql => { raw.exec(sql); setup.push(sql); };
  try {
    apply("UPDATE projects SET local_path='/logical/checkout' WHERE id=1");
    if (test.second) {
      apply("INSERT INTO projects(id,tenant_id,name,url,local_path) VALUES(2,'default','Addon','https://example.test/addon','/logical/addon')");
      apply("INSERT INTO profile_layers(tenant_id,profile_id,layer_order,layer_type,project_id) VALUES('default',1,1,'addon',2)");
    }
    if (test.sql) apply(test.sql);
    if (test.hints) writeFileSync(join(directory, 'path-hints.yaml'), test.hints);
    const repo = ports.repository;
    if (!test.capture) {
      for (const id of test.second ? [1, 2] : [1]) {
        const checkout = join(directory, `checkout-${id}`);
        const revision = join(directory, 'repos/1/revisions/accepted');
        mkdirSync(checkout, { recursive: true });
        mkdirSync(revision, { recursive: true });
        if (test.name !== 'no-root') raw.prepare('UPDATE projects SET local_path=? WHERE id=?').run(checkout, id);
        for (const file of test.files.filter(file => file.source === id)) {
          for (const root of id === 1 ? [checkout, revision] : [checkout]) {
            mkdirSync(dirname(join(root, file.path)), { recursive: true });
            writeFileSync(join(root, file.path), file.content);
          }
        }
        if (test.docs?.[id]) writeFileSync(join(checkout, 'print-partner.manifest.yaml'), test.docs[id]);
      }
    } else {
      repo.resolveSourceSnapshotPath = (id, locator) => `/logical/${locator}`;
    }
    const base = test.base ?? { baseRevisionId: null, basePlanVersion: 0 };
    const options = test.options ?? {};
    const map = value => value === undefined ? undefined : new Map(Object.entries(value).map(([id, paths]) => [Number(id), new Set(paths)]));
    let result;
    try {
      if (test.capture) {
        const captured = repo.capturePlanInputs(1);
        const inputs = captured.inputs.map(({ source_name: _name, source_id, source_layer, layer_order, tracking_kind, source_revision_id, manifest_digest, effective_naming_digest }) => ({ sourceId: source_id, sourceLayer: source_layer, layerOrder: layer_order, trackingKind: tracking_kind, sourceRevisionId: source_revision_id, manifestDigest: manifest_digest, effectiveNamingDigest: effective_naming_digest }));
        result = { fingerprint: captured.fingerprint, inputs };
      } else {
        const prepared = repo.preparePlanDraft(1, base, { applyManifest: options.applyManifest ?? true, preferAccepted: options.preferAccepted ?? false, excludedPathsBySourceId: map(options.excluded), includedPathsBySourceId: map(options.included), partChoicesBySourceId: options.choices === undefined ? undefined : new Map(Object.entries(options.choices).map(([id, choices]) => [Number(id), new Map(Object.entries(choices))])) });
        result = prepared.kind === 'prepared' ? { kind: 'prepared', inputs: prepared.value.inputs, parts: prepared.value.parts, digest: prepared.value.snapshotDigest } : prepared;
      }
    } catch (error) { result = { error: error.message }; }
    output.push({ ...test, setup, base, options, result });
  } finally { raw.close(); await ports.db.close(); rmSync(directory, { recursive: true, force: true }); }
}
process.stdout.write(`${output.map(row => JSON.stringify(row)).join('\n')}\n`);

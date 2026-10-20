import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const { createSelfHostPorts } = await import(join(resolve(process.argv[2]), 'src/adapters/self-host/index.ts'));
// Rust strings are independent expectations, never translated from Node errors.
const cases = [
  ['unknown-top', { surprise: true }, 'Unknown naming field'],
  ['unknown-role', { roles: [{ id: 'primary', surprise: true }] }, 'unknown field `surprise`, expected one of `id`, `label`, `markers`'],
  ['unknown-quantity', { quantity: { surprise: true } }, 'unknown field `surprise`, expected `regex` or `default`'],
  ['unknown-slug', { slug: { surprise: true } }, 'unknown field `surprise`, expected `strip_markers` or `strip_quantity`'],
  ['unknown-folder', { folder_rules: [{ path_contains: 'frame', role_id: 'primary', surprise: true }] }, 'unknown field `surprise`, expected one of `path_contains`, `role_id`, `functional_class`'],
  ['duplicate-roles', { roles: [{ id: 'primary' }, { id: 'primary' }] }, 'Duplicate role override'],
  ['invalid-role-id', { roles: [{ id: 'future' }] }, 'unknown variant `future`, expected one of `primary`, `accent`, `clear`, `opaque`'],
  ['raw-override-array', [], 'Invalid naming override'],
  ['raw-roles-null', { roles: null }, 'Invalid roles'],
  ['raw-label-number', { roles: [{ id: 'primary', label: 7 }] }, 'invalid type: integer `7`, expected a string'],
  ['raw-marker-number', { roles: [{ id: 'primary', markers: [7] }] }, 'invalid type: integer `7`, expected a string'],
  ['raw-quantity-string', { quantity: { default: '2' } }, 'invalid type: string "2", expected u64'],
  ['raw-slug-string', { slug: { strip_quantity: 'true' } }, 'invalid type: string "true", expected a boolean'],
  ['raw-folder-string', { folder_rules: 'frame' }, 'invalid type: string "frame", expected a sequence'],
  ['blank-label', { roles: [{ id: 'accent' }, { id: 'primary', label: ' \ufeff' }] }, 'Blank naming label', 'override.roles.1.label: must not be blank'],
  ['blank-folder', { folder_rules: [{ path_contains: ' ', role_id: 'primary' }] }, 'Blank folder rule', 'override.folder_rules.0.path_contains: must not be blank'],
  ['blank-regex', { quantity: { regex: ' ' } }, 'Quantity regex must have one capture group', 'override.quantity.regex: must not be blank'],
  ['mixed-unknown-top-blank-label', { surprise: true, roles: [{ id: 'primary', label: ' ' }] }, 'Unknown naming field', 'override.roles.0.label: must not be blank'],
  ['mixed-invalid-role-blank-regex', { roles: [{ id: 'future' }], quantity: { regex: ' ' } }, 'unknown variant `future`, expected one of `primary`, `accent`, `clear`, `opaque`', 'override.quantity.regex: must not be blank'],
  ['mixed-quantity-type-blank-folder', { quantity: { default: '2' }, folder_rules: [{ path_contains: ' ', role_id: 'primary' }] }, 'invalid type: string "2", expected u64', 'override.folder_rules.0.path_contains: must not be blank'],
  ['mixed-duplicate-blank-label', { roles: [{ id: 'primary' }, { id: 'primary', label: ' ' }] }, 'Duplicate role override', 'override.roles.1.label: must not be blank'],
];

function files(directory, relative = '') {
  return readdirSync(join(directory, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) return files(directory, path);
      if (relative === '' && /^print-partner\.db(?:-wal|-shm)?$/.test(entry.name)) return [];
      return [[path, readFileSync(join(directory, path)).toString('hex')]];
    });
}

const output = [];
for (const [name, override, rust_off, rust_on = rust_off] of cases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-gre918-node-'));
  copyFileSync(join(here, 'required-units/unchanged.db'), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  try {
    const root = join(directory, 'repos/1/revisions/fixture');
    mkdirSync(root, { recursive: true });
    for (const [file, body] of [['frame.stl', 'disposable STL'], ['manifest.yaml', 'parts: []\n'], ['catalog.yaml', 'parts: []\n']]) {
      writeFileSync(join(root, file), body);
    }
    raw.prepare('UPDATE projects SET local_path=?, metadata_json=? WHERE id=1')
      .run(root, JSON.stringify({ naming: { use_defaults: false, override } }));
    const rows = () => raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
    const before = { rows: rows(), files: files(directory) };
    const unchanged = () => assert.deepEqual({ rows: rows(), files: files(directory) }, before, name);
    const node_catalog = ports.repository.getSourceNaming(1);
    unchanged();
    assert.deepEqual(node_catalog, { kind: 'invalid_state' }, name);
    let node_preparation;
    try {
      ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: name, applyManifest: true });
    } catch (error) { node_preparation = error.message; }
    unchanged();
    assert.equal(typeof node_preparation, 'string', name);
    output.push({ name, override, node_catalog, node_preparation, rust_off, rust_on,
      known_mismatch: { feature_off: rust_off !== node_preparation, feature_on: rust_on !== node_preparation } });
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
process.stdout.write(`${output.map(row => JSON.stringify(row)).join('\n')}\n`);

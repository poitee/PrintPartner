import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const { createSelfHostPorts } = await import(join(resolve(process.argv[2]), 'src/adapters/self-host/index.ts'));
// Stored verbatim, so key order JavaScript objects would normalize survives.
class Raw { constructor(text) { this.text = text; } }
// Rust strings are independent expectations, never translated from Node errors.
const cases = [
  ['unknown-top', { surprise: true }, "Unknown naming field", "override: Unrecognized key: \"surprise\""],
  ['unknown-role', { roles: [{ id: 'primary', surprise: true }] }, "unknown field `surprise`, expected one of `id`, `label`, `markers`", "override.roles.0: Unrecognized key: \"surprise\""],
  ['unknown-quantity', { quantity: { surprise: true } }, "unknown field `surprise`, expected `regex` or `default`", "override.quantity: Unrecognized key: \"surprise\""],
  ['unknown-slug', { slug: { surprise: true } }, "unknown field `surprise`, expected `strip_markers` or `strip_quantity`", "override.slug: Unrecognized key: \"surprise\""],
  ['unknown-folder', { folder_rules: [{ path_contains: 'frame', role_id: 'primary', surprise: true }] }, "unknown field `surprise`, expected one of `path_contains`, `role_id`, `functional_class`", "override.folder_rules.0: Unrecognized key: \"surprise\""],
  ['duplicate-roles', { roles: [{ id: 'primary' }, { id: 'primary' }] }, "Duplicate role override", "override.roles: role ids must be unique"],
  ['invalid-role-id', { roles: [{ id: 'future' }] }, "unknown variant `future`, expected one of `primary`, `accent`, `clear`, `opaque`", "override.roles.0.id: Invalid option: expected one of \"primary\"|\"accent\"|\"clear\"|\"opaque\""],
  ['raw-override-array', [], "Invalid naming override", "override: Invalid input: expected object, received array"],
  ['raw-roles-null', { roles: null }, "Invalid roles", "override.roles: Invalid input: expected array, received null"],
  ['raw-label-number', { roles: [{ id: 'primary', label: 7 }] }, "invalid type: integer `7`, expected a string", "override.roles.0.label: Invalid input: expected string, received number"],
  ['raw-marker-number', { roles: [{ id: 'primary', markers: [7] }] }, "invalid type: integer `7`, expected a string", "override.roles.0.markers.0: Invalid input: expected string, received number"],
  ['raw-quantity-string', { quantity: { default: '2' } }, "invalid type: string \"2\", expected u64", "override.quantity.default: Invalid input: expected number, received string"],
  ['raw-slug-string', { slug: { strip_quantity: 'true' } }, "invalid type: string \"true\", expected a boolean", "override.slug.strip_quantity: Invalid input: expected boolean, received string"],
  ['raw-folder-string', { folder_rules: 'frame' }, "invalid type: string \"frame\", expected a sequence", "override.folder_rules: Invalid input: expected array, received string"],
  ['blank-label', { roles: [{ id: 'accent' }, { id: 'primary', label: ' \ufeff' }] }, "Blank naming label", "override.roles.1.label: must not be blank"],
  ['blank-folder', { folder_rules: [{ path_contains: ' ', role_id: 'primary' }] }, "Blank folder rule", "override.folder_rules.0.path_contains: must not be blank"],
  ['blank-regex', { quantity: { regex: ' ' } }, "Quantity regex must have one capture group", "override.quantity.regex: must not be blank"],
  ['mixed-unknown-top-blank-label', { surprise: true, roles: [{ id: 'primary', label: ' ' }] }, "Unknown naming field", "override.roles.0.label: must not be blank"],
  ['mixed-invalid-role-blank-regex', { roles: [{ id: 'future' }], quantity: { regex: ' ' } }, "unknown variant `future`, expected one of `primary`, `accent`, `clear`, `opaque`", "override.roles.0.id: Invalid option: expected one of \"primary\"|\"accent\"|\"clear\"|\"opaque\""],
  ['mixed-quantity-type-blank-folder', { quantity: { default: '2' }, folder_rules: [{ path_contains: ' ', role_id: 'primary' }] }, "invalid type: string \"2\", expected u64", "override.quantity.default: Invalid input: expected number, received string"],
  ['mixed-duplicate-blank-label', { roles: [{ id: 'primary' }, { id: 'primary', label: ' ' }] }, "Duplicate role override", "override.roles.1.label: must not be blank"],
  ['empty-roles', { roles: [] }, "Empty roles override", "override.roles: must contain at least one role override"],
  ['unknown-top-plural', { surprise: true, other: 1 }, "Unknown naming field", "override: Unrecognized keys: \"surprise\", \"other\""],
  ['invalid-regex', { quantity: { regex: '(' } }, "Invalid quantity regex structure", "override.quantity.regex: is an invalid regular expression"],
  ['regex-two-groups', { quantity: { regex: '(a)(b)' } }, "Quantity regex must have one capture group", "override.quantity.regex: must contain exactly one capture group"],
  ['quantity-zero', { quantity: { default: 0 } }, "Invalid quantity default", "override.quantity.default: Too small: expected number to be >=1"],
  ['quantity-fraction', { quantity: { default: 1.5 } }, "invalid type: floating point `1.5`, expected u64", "override.quantity.default: Invalid input: expected int, received number"],
  ['invalid-functional-class', { folder_rules: [{ path_contains: 'frame', role_id: 'primary', functional_class: 'decorative' }] }, "unknown variant `decorative`, expected `functional` or `cosmetic`", "override.folder_rules.0.functional_class: Invalid option: expected one of \"functional\"|\"cosmetic\""],
  ['export-order-short', { export_role_order: ['primary'] }, "Invalid export role order", "override.export_role_order: Too small: expected array to have exactly 4 items"],
  ['export-order-duplicate', { export_role_order: ['primary', 'primary', 'clear', 'opaque'] }, "Duplicate export role", "override.export_role_order: must list each role id exactly once"],
  ['mixed-label-type-unknown-quantity', { roles: [{ id: 'primary', label: 7 }], quantity: { surprise: true } }, "invalid type: integer `7`, expected a string", "override.roles.0.label: Invalid input: expected string, received number"],
  ['mixed-export-long-invalid', { export_role_order: ['primary', 'accent', 'clear', 'opaque', null] }, "invalid type: null, expected string or map", "override.export_role_order: Too big: expected array to have exactly 4 items"],
  ['unknown-keys-index-order', new Raw('{"surprise":true,"2":true,"1":true}'), "Unknown naming field", "override: Unrecognized keys: \"1\", \"2\", \"surprise\""],
  ['unknown-key-quote', { 'a"b\\c': true }, "Unknown naming field", "override: Unrecognized key: \"a\"b\\c\""],
  ['regex-over-group-limit', { quantity: { regex: '(a)'.repeat(65) } }, "Quantity regex exceeds group complexity limits", "override.quantity.regex: Quantity regex exceeds group complexity limits"],
  ['regex-over-limit-unbalanced', { quantity: { regex: '('.repeat(17) } }, "Quantity regex exceeds group complexity limits", "override.quantity.regex: is an invalid regular expression"],
  ['mixed-regex-modifier-default-zero', { quantity: { regex: '(?i:(a))', default: 0 } }, "Invalid quantity default", "override.quantity.regex: is an invalid regular expression"],
  ['regex-duplicate-group-name', { quantity: { regex: '(?<x>a)|(?<x>b)' } }, "Quantity regex must have one capture group", "override.quantity.regex: is an invalid regular expression"],
  ['mixed-regex-non-ascii-default-zero', { quantity: { regex: 'é(?<é>a)', default: 0 } }, "Invalid quantity default", "override.quantity.default: Too small: expected number to be >=1"],
  ['regex-duplicate-group-name-unicode', { quantity: { regex: String.raw`(?<\u0078>a)|(?<x>b)` } }, "Quantity regex must have one capture group", "override.quantity.regex: is an invalid regular expression"],
  ['regex-duplicate-group-name-code-point', { quantity: { regex: String.raw`(?<\u{78}>a)|(?<x>b)` } }, "Quantity regex must have one capture group", "override.quantity.regex: is an invalid regular expression"],
  ['regex-duplicate-group-name-both-escaped', { quantity: { regex: String.raw`(?<\u0078>a)|(?<\u{78}>b)` } }, "Quantity regex must have one capture group", "override.quantity.regex: is an invalid regular expression"],
  ['regex-duplicate-group-name-surrogates', { quantity: { regex: String.raw`(?<\uD835\uDC9C>a)|(?<𝒜>b)` } }, "Quantity regex must have one capture group", "override.quantity.regex: is an invalid regular expression"],
  ['regex-duplicate-group-name-astral', { quantity: { regex: String.raw`(?<\u{1D49C}>a)|(?<𝒜>b)` } }, "Quantity regex must have one capture group", "override.quantity.regex: is an invalid regular expression"],
  ['mixed-regex-group-name-hex-default-zero', { quantity: { regex: String.raw`(?<\x78>a)|(?<x>b)`, default: 0 } }, "Invalid quantity default", "override.quantity.regex: is an invalid regular expression"],
  ['regex-distinct-escaped-group-names', { quantity: { regex: String.raw`(?<\u0078>a)|(?<\u{79}>b)` } }, "Quantity regex must have one capture group", "override.quantity.regex: must contain exactly one capture group"],
  ['mixed-regex-depth-limit-default-zero', { quantity: { regex: '(?:'.repeat(17) + '(a)' + ')'.repeat(17), default: 0 } }, "Invalid quantity default", "override.quantity.default: Too small: expected number to be >=1"],
  ['mixed-regex-length-limit-default-zero', { quantity: { regex: 'a'.repeat(4097) + '(a)', default: 0 } }, "Invalid quantity default", "override.quantity.default: Too small: expected number to be >=1"],
  ['mixed-regex-count-limit-default-zero', { quantity: { regex: '(?:a)'.repeat(65) + '(a)', default: 0 } }, "Invalid quantity default", "override.quantity.default: Too small: expected number to be >=1"],
  ['mixed-regex-depth-limit-slug-type', { quantity: { regex: '(?:'.repeat(17) + '(a)' + ')'.repeat(17) }, slug: { strip_quantity: 'true' } }, "invalid type: string \"true\", expected a boolean", "override.slug.strip_quantity: Invalid input: expected boolean, received string"],
  ['mixed-regex-count-limit-blank-folder', { quantity: { regex: '(?:a)'.repeat(65) + '(a)' }, folder_rules: [{ path_contains: ' ', role_id: 'primary' }] }, "Quantity regex exceeds group complexity limits", "override.folder_rules.0.path_contains: must not be blank"],
  ['mixed-regex-depth-limit-export-short', { quantity: { regex: '(?:'.repeat(17) + '(a)' + ')'.repeat(17) }, export_role_order: ['primary'] }, "Invalid export role order", "override.export_role_order: Too small: expected array to have exactly 4 items"],
  ['mixed-regex-depth-limit-unknown-top', { quantity: { regex: '(?:'.repeat(17) + '(a)' + ')'.repeat(17) }, surprise: true }, "Unknown naming field", "override: Unrecognized key: \"surprise\""],
  ['mixed-regex-depth-limit-unknown-quantity', { quantity: { regex: '(?:'.repeat(17) + '(a)' + ')'.repeat(17), surprise: true } }, "unknown field `surprise`, expected `regex` or `default`", "override.quantity: Unrecognized key: \"surprise\""],
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
    const stored = override instanceof Raw
      ? `{"naming":{"use_defaults":false,"override":${override.text}}}`
      : JSON.stringify({ naming: { use_defaults: false, override } });
    raw.prepare('UPDATE projects SET local_path=?, metadata_json=? WHERE id=1').run(root, stored);
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
    const recorded = override instanceof Raw
      ? { override: JSON.parse(override.text), override_json: override.text }
      : { override };
    output.push({ name, ...recorded, node_catalog, node_preparation, rust_off, rust_on,
      known_mismatch: { feature_off: rust_off !== node_preparation, feature_on: rust_on !== node_preparation } });
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
process.stdout.write(`${output.map(row => JSON.stringify(row)).join('\n')}\n`);

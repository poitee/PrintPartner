import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const { createSelfHostPorts } = await import(join(resolve(process.argv[2]), 'src/adapters/self-host/index.ts'));
const output = [];
for (const [name, override] of [
  ['null-class', { folder_rules: [{ path_contains: 'frame', role_id: 'primary', functional_class: null }] }],
  ['blank-label', { roles: [{ id: 'accent' }, { id: 'primary', label: ' \ufeff' }] }],
  ['blank-folder', { folder_rules: [{ path_contains: ' ', role_id: 'primary' }] }],
  ['blank-regex', { quantity: { regex: ' ' } }],
  ['missing-base', {}],
]) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-naming-node-'));
  copyFileSync(join(here, 'required-units/unchanged.db'), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  try {
    const root = join(directory, 'repos/1/revisions/fixture');
    mkdirSync(root, { recursive: true });
    const file = join(root, 'frame.stl');
    writeFileSync(file, 'disposable STL');
    raw.prepare('UPDATE projects SET local_path=?, metadata_json=? WHERE id=1')
      .run(root, JSON.stringify({ naming: { use_defaults: false, override } }));
    if (name === 'missing-base') raw.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER trg_build_profiles_revision_ownership_update; UPDATE build_profiles SET accepted_plan_revision_id=999 WHERE id=1');
    const rows = () => raw.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name').all()
      .map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
    const before = rows();
    const catalog = ports.repository.getSourceNaming(1).kind;
    let error;
    try {
      ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: name, applyManifest: true });
    } catch (caught) { error = caught.message; }
    assert.equal(typeof error, 'string');
    assert.deepEqual(rows(), before);
    assert.equal(readFileSync(file, 'utf8'), 'disposable STL');
    output.push({ name, override, catalog, error });
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
process.stdout.write(`${output.map(row => JSON.stringify(row)).join('\n')}\n`);

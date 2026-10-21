import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
process.env.PP_DESKTOP_REBUILD = '1';
const { createSelfHostPorts } = await import(join(resolve(process.argv[2]), 'src/adapters/self-host/index.ts'));
const naming = { roles: [{ id: 'primary', label: 'Primary', markers: [] }, { id: 'accent', label: 'Accent', markers: [] }, { id: 'clear', label: 'Clear', markers: [] }, { id: 'opaque', label: 'Opaque', markers: [] }], quantity: { regex: '_pieces([0-9]+)[a-z]*\\.stl$', default: 1 }, slug: { strip_markers: false, strip_quantity: true }, folder_rules: [], export_role_order: ['primary', 'accent', 'clear', 'opaque'] };
const setup = [`INSERT OR REPLACE INTO app_settings(tenant_id,key,value) VALUES('default','stl_naming_defaults','${JSON.stringify(naming)}')`];
const cases = [
  // V8 keeps U+017F, U+0131 and U+212A apart from the ASCII letters they
  // case-map to. A part whose slug the strip regex reduces to a sibling's
  // slug turns both into conflicts.
  { name: 'long-s', files: ['bolt_piece\u017f3.stl', 'bolt.stl', 'nut_p\u0131eces2.stl', 'nut.stl', 'washer_pieces4\u212a.stl', 'washer.stl', 'clip_pieces5\u017f.stl', 'clip.stl', '\u017fpring_pieces6.stl', '\u017fpring.stl'] },
  { name: 'ascii', files: ['bolt_PIECES3.stl', 'bolt.stl', 'nut_pieces2x.stl', 'washer_Pieces4k.stl', 'spring.stl'] },
];
for (const { name, files } of cases) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-quantity-folding-node-'));
  copyFileSync(join(here, 'required-units/unchanged.db'), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  try {
    for (const sql of setup) raw.exec(sql);
    for (const root of [join(directory, 'repos/1/revisions/fixture'), join(directory, 'checkout')]) {
      mkdirSync(root, { recursive: true });
      for (const file of files) writeFileSync(join(root, file), file);
    }
    raw.prepare('UPDATE projects SET local_path=? WHERE id=1').run(join(directory, 'checkout'));
    const result = ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: 'first', applyManifest: true });
    result.draft.createdAt = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.draft.createdAt);
    process.stdout.write(`${JSON.stringify({ name, setup, files, result })}\n`);
  } finally {
    raw.close();
    await ports.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

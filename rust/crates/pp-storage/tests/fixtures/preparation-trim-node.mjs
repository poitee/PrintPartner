import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
process.env.PP_DESKTOP_REBUILD = '1';
const { createSelfHostPorts } = await import(join(resolve(process.argv[2]), 'src/adapters/self-host/index.ts'));
const output = [];
for (const [name, space] of [['bom', '\ufeff'], ['ordinary', ' '], ['non-js', '\u0085']]) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-trim-node-'));
  copyFileSync(join(here, 'required-units/unchanged.db'), join(directory, 'print-partner.db'));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const raw = new DatabaseSync(join(directory, 'print-partner.db'));
  try {
    const files = [`${space}folder/part.stl`, `part_x${name === 'non-js' ? '' : space}3.stl`, `${space}marked.stl`, 'plain.stl'];
    const naming = { roles: [{ id: 'primary', label: 'Primary', markers: [] }, { id: 'accent', label: 'Accent', markers: [space] }, { id: 'clear', label: 'Clear', markers: [] }, { id: 'opaque', label: 'Opaque', markers: [] }], quantity: { regex: '_x(.+)\\.stl$', default: 1 }, slug: { strip_markers: true, strip_quantity: true }, folder_rules: [], export_role_order: ['primary', 'accent', 'clear', 'opaque'] };
    const setting = (key, value) => `INSERT OR REPLACE INTO app_settings(tenant_id,key,value) VALUES('default','${key}','${JSON.stringify(value).replaceAll("'", "''")}')`;
    const setup = [
      `UPDATE projects SET imported_paths='${(name === 'non-js' ? JSON.stringify([`${space}folder${space}`, `${space}plain.stl${space}`, space]) : space + JSON.stringify([`${space}folder${space}`, `${space}plain.stl${space}`, space]) + space).replaceAll("'", "''")}' WHERE id=1`,
      setting('stl_naming_defaults', naming),
      setting('role_filaments_1', { primary: { filament_color_id: `${space}spoolman:17`, spoolman_spool_id: '17' }, accent: { filament_color_id: 'accent' } }),
    ];
    for (const root of [join(directory, 'checkout'), join(directory, 'repos/1/revisions/fixture')]) {
      mkdirSync(root, { recursive: true });
      for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), file); }
    }
    raw.prepare('UPDATE projects SET local_path=? WHERE id=1').run(join(directory, 'checkout'));
    for (const sql of setup) raw.exec(sql);
    const project = result => ({ kind: result.kind, parts: result.draft?.parts.map(p => ({ relativePath: p.relativePath, roleInferred: p.roleInferred, quantityInferred: p.quantityInferred, included: p.included, filamentColorId: p.filamentColorId, spoolmanSpoolId: p.spoolmanSpoolId })) });
    const filtered = project(ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: 'filtered', applyManifest: true }));
    raw.exec('UPDATE projects SET imported_paths=NULL WHERE id=1');
    const unfiltered = project(ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: 'unfiltered', applyManifest: true }));
    raw.prepare('UPDATE projects SET imported_paths=? WHERE id=1').run(`${space}["plain.stl"]${space}`);
    const wrapped = project(ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: 'wrapped', applyManifest: true }));
    const prefixQuantity = Number.isNaN(parseInt(`${space}3`, 10)) ? null : parseInt(`${space}3`, 10);
    output.push({ name, files, setup, filtered, unfiltered, wrapped, prefixQuantity });
  } finally { raw.close(); await ports.db.close(); rmSync(directory, { recursive: true, force: true }); }
}
process.stdout.write(`${output.map(row => JSON.stringify(row)).join('\n')}\n`);

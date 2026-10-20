import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
process.env.PP_DESKTOP_REBUILD = '1';
const { createSelfHostPorts } = await import(join(resolve(process.argv[2]), 'src/adapters/self-host/index.ts'));
const files = ['bracket.stl', 'excluded.stl', 'gear.stl', 'new.stl'];
const hints = { version: 1, rules: [
  { path: 'bracket.stl', option_group: 'tool', variant_id: 'bracket' },
  { path: 'bracket.stl', option_group: 'tool', variant_id: 'bracket', label: 'Later label' },
  { path: 'absent.stl', option_group: 'missing', variant_id: 'none' },
] };
const directory = mkdtempSync(join(tmpdir(), 'pp-hints-node-'));
copyFileSync(join(here, 'required-units/unchanged.db'), join(directory, 'print-partner.db'));
const ports = createSelfHostPorts(directory);
await ports.db.connect();
const raw = new DatabaseSync(join(directory, 'print-partner.db'));
try {
  for (const root of [join(directory, 'repos/1/revisions/fixture'), join(directory, 'checkout')]) {
    mkdirSync(root, { recursive: true });
    for (const file of files) writeFileSync(join(root, file), file);
  }
  raw.prepare('UPDATE projects SET local_path=? WHERE id=1').run(join(directory, 'checkout'));
  writeFileSync(join(directory, 'path-hints.yaml'), JSON.stringify(hints));
  const result = ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: 'first', applyManifest: true });
  result.draft.createdAt = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.draft.createdAt);
  process.stdout.write(`${JSON.stringify({ files, hints, result })}\n`);
} finally {
  raw.close();
  await ports.db.close();
  rmSync(directory, { recursive: true, force: true });
}

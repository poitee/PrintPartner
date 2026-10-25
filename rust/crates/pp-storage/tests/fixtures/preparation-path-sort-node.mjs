import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
process.env.PP_DESKTOP_REBUILD = '1';
const { createSelfHostPorts } = await import(join(resolve(process.argv[2]), 'src/adapters/self-host/index.ts'));
const files = ['a-.stl', 'a.stl', 'a_.stl', 'dir10/x.stl', 'dir2/x.stl', 'e.stl', 'e\u00ad.stl', 'part10.stl', 'part2.stl', 'Ä.stl', 'é.stl'];
const directory = mkdtempSync(join(tmpdir(), 'pp-path-sort-node-'));
copyFileSync(join(here, 'required-units/unchanged.db'), join(directory, 'print-partner.db'));
const ports = createSelfHostPorts(directory);
await ports.db.connect();
const raw = new DatabaseSync(join(directory, 'print-partner.db'));
try {
  for (const root of [join(directory, 'repos/1/revisions/fixture'), join(directory, 'checkout')]) {
    mkdirSync(root, { recursive: true });
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file);
    }
  }
  raw.prepare('UPDATE projects SET local_path=? WHERE id=1').run(join(directory, 'checkout'));
  const result = ports.repository.recomputePlanDraft({ profileId: 1, actor: 'default', idempotencyKey: 'first', applyManifest: true });
  result.draft.createdAt = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.draft.createdAt);
  process.stdout.write(`${JSON.stringify({ files, result })}\n`);
} finally {
  raw.close();
  await ports.db.close();
  rmSync(directory, { recursive: true, force: true });
}

// From web: npx tsx --conditions=development ../rust/crates/pp-storage/tests/fixtures/manifest-commands-node.mts apps/server
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const server = resolve(process.argv[2] ?? "apps/server");
const { createSelfHostPorts } = await import(join(server, "src/adapters/self-host/index.ts"));
const { loadKitManifest, saveKitManifest, parseKitManifestUpdate } = await import(join(server, "src/services/kit-manifest-store.ts"));
const { buildPlanManifestBuilder } = await import(join(server, "src/services/plan-manifest-builder.ts"));
const directory = mkdtempSync(join(tmpdir(), "pp-manifest-commands-node-"));
process.env.PRINT_PARTNER_DATA_DIR = directory;
const ports = createSelfHostPorts(directory);
await ports.db.connect();
const repo = ports.repository;
try {
  const source = repo.createSource({ name: "Base", url: "https://example.test/Base" });
  const root = join(directory, "repos", String(source.id));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "part.stl"), "solid part");
  writeFileSync(join(root, "print-partner.manifest.yaml"), "option_groups:\n  toolhead:\n    variants:\n      - id: stock\n        parts: [part.stl]\n      - id: mini\n        parts: [mini.stl]\nselections:\n  toolhead: stock\n");
  repo.updateSource(source.id, { local_path: root });
  const plan = repo.createProfile("Manifest commands", source.id);
  const empty = { profile_id: plan.id, kit: loadKitManifest(repo, plan.id) };
  const builder = buildPlanManifestBuilder(repo, plan.id, directory);
  const saved = { profile_id: plan.id, kit: saveKitManifest(repo, plan.id, parseKitManifestUpdate({ name: "Saved", selections: { toolhead: " mini " }, include: ["part.stl"] })) };
  process.stdout.write(JSON.stringify({ empty, builder, saved }) + "\n");
} finally {
  await ports.db.close();
  rmSync(directory, { recursive: true, force: true });
}

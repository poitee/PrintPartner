// Regenerate manifest-builder-node.json from the web directory:
//   npx tsx --conditions=development ../rust/crates/pp-storage/tests/fixtures/manifest-builder-node.mts apps/server > ../rust/crates/pp-storage/tests/fixtures/manifest-builder-node.json
// Node reads community manifests only from its shipped data directory, so the
// script writes manifests/oracle-kit.yaml there and removes it afterwards.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const server = resolve(process.argv[2] ?? "apps/server");
const { createSelfHostPorts } = await import(join(server, "src/adapters/self-host/index.ts"));
const { saveKitManifest } = await import(join(server, "src/services/kit-manifest-store.ts"));
const { buildPlanManifestBuilder } = await import(
  join(server, "src/services/plan-manifest-builder.ts")
);

const dir = mkdtempSync(join(tmpdir(), "pp-manifest-builder-node-"));
process.env.PRINT_PARTNER_DATA_DIR = dir;
const community = join(server, "src/data/manifests/oracle-kit.yaml");
const ports = createSelfHostPorts(dir);
await ports.db.connect();
const repo = ports.repository;

function source(name: string, files: Record<string, string | Buffer | null>): number {
  const created = repo.createSource({ name, url: `https://example.test/${name.replace(/ /g, "-")}` });
  const root = join(dir, "repos", String(created.id));
  mkdirSync(root, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    if (body === null) {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, body);
    }
  }
  repo.updateSource(created.id, { local_path: root });
  return created.id;
}

try {
  const base = source("Base Frame", {
    "toolhead/stock/a.stl": "solid a",
    "toolhead/custom/B.stl": "solid b",
    "extras/skirt.stl": "solid s",
    "docs/ignored.stl": "solid d",
    "print-partner.manifest.yaml": `format: print-partner-manifest-v2
version: 2
project: ignored-name
option_groups:
  toolhead:
    label: Toolhead
    variants:
      - id: stock
        parts: ["toolhead/stock/**"]
      - id: custom
        label: Custom
        parts: ["toolhead/custom/**"]
  "7":
    rule: pick_any
    max: 2
    variants:
      - id: skirt
        parts: [skirt.stl]
selections:
  toolhead: stock
  "7": [skirt]
`,
  });
  const addon = source("Addon Kit", {
    "toolhead/stock/c.stl": "solid c",
    "toolhead/mini/m.stl": "solid m",
    "print-partner.manifest.yaml": Buffer.concat([
      Buffer.from("# caf"),
      Buffer.from([0xff]),
      Buffer.from(`
option_groups:
  toolhead:
    label: Addon toolhead
    variants:
      - id: stock
        label: Stock
        parts: ["toolhead/stock/**", "extra/**"]
      - id: mini
        parts: ["toolhead/mini/**"]
      - id: mini
        label: Mini
        parts: ["toolhead/mini/*.stl"]
  alpha:
    variants:
      - id: enabled
        parts: ["nothing/**"]
selections:
  toolhead: mini
  alpha: [enabled]
`),
    ]),
  });
  repo.updateSource(addon, { manifest_community_slug: "oracle-kit" });
  writeFileSync(community, "selections:\n  beta: x\n  toolhead: custom\n");
  const fallback = source("Fallback Source", {
    "options/stock/a.stl": "solid a",
    "options/custom/b.stl": "solid b",
    "frame/rail_mount.stl": "solid r",
    "print-partner.manifest.yaml": "not: [valid",
  });
  const directory = source("Directory Manifest", {
    "part.stl": "solid p",
    "print-partner.manifest.yaml": null,
  });
  writeFileSync(
    join(dir, "path-hints.yaml"),
    'version: 1\nrules:\n  - path: "**/rail_mount.stl"\n    option_group: rail_mounts\n    variant_id: printed_mount\n',
  );
  const plan = repo.createProfile("Oracle", base);
  for (const id of [addon, fallback, directory]) repo.addAddonLayer(plan.id, id);
  saveKitManifest(repo, plan.id, { selections: { zeta: "z1" } });
  assert.deepEqual([base, addon, fallback, directory, plan.id], [1, 2, 3, 4, 1]);
  const database = new DatabaseSync(join(dir, "print-partner.db"));
  database
    .prepare("UPDATE projects SET imported_paths=? WHERE id=?")
    .run('["\\ufeff toolhead", "/extras/skirt.stl", "", 7]', base);
  database.close();
  process.stdout.write(`${JSON.stringify(buildPlanManifestBuilder(repo, plan.id, dir))}\n`);
} finally {
  rmSync(community, { force: true });
  await ports.db.close();
  rmSync(dir, { recursive: true, force: true });
}

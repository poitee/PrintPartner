// Captures what Node's profile sync writes and broadcasts for every file under
// roots/. Runs the real startProfileSyncWatcher with a recording repository,
// calls syncAll() once, and stops before the watcher's own initial scan.
// From web/: node --conditions=development --import tsx ../fixtures/parity/profile-sync/generate.mjs [--check]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, "../../../web/apps/server");
const { startProfileSyncWatcher } = await import(join(server, "src/services/profile-sync.ts"));
const { getLogger } = await import(join(server, "src/services/logger.ts"));
const { defaultWatchDirs } = await import(join(server, "src/services/slicer-instances.ts"));

const rel = (absolute) => relative(here, absolute).split(sep).join("/");
const roots = [
  { kind: "orca", baseDir: "roots/orca", dirs: defaultWatchDirs("orca_json") },
  { kind: "bambu", baseDir: "roots/bambu", dirs: defaultWatchDirs("bambu_json") },
  { kind: "prusa", baseDir: "roots/prusa", dirs: defaultWatchDirs("prusa_ini") },
];

const outcomes = [];
const record = (table) => (input) =>
  outcomes.push({ path: rel(input.sourcePath), table, input: { ...input, sourcePath: rel(input.sourcePath) } });
const repo = {
  upsertSyncedPrinterProfile: record("printer"),
  upsertSyncedProcessProfile: record("process"),
  upsertSyncedFilamentProfile: record("filament"),
};
const logger = getLogger();
const log = logger.log.bind(logger);
logger.log = (severity, message, ...rest) => {
  const failed = /^\[profile-sync\] failed to parse (.*?): /.exec(message);
  if (failed) outcomes.push({ path: rel(failed[1]), failed: true });
  else return log(severity, message, ...rest);
};

const handle = startProfileSyncWatcher(
  repo,
  { enabled: true, roots: roots.map((root) => ({ ...root, baseDir: join(here, root.baseDir) })) },
  (event) => {
    const last = outcomes.at(-1);
    assert.ok(last && !last.failed && !last.event, "emit follows exactly one upsert");
    last.event = event;
  },
);
await handle.syncAll();
const captured = outcomes.splice(0);
await handle.stop();
logger.log = log;
assert.ok(captured.every((o) => o.failed || o.event), "every upsert emitted an event");

const path = join(here, "node.json");
// One outcome per line keeps the golden small and its diffs readable.
const lines = captured.map((outcome) => `    ${JSON.stringify(outcome)}`).join(",\n");
const bytes = `{\n  "roots": ${JSON.stringify(roots)},\n  "outcomes": [\n${lines}\n  ]\n}\n`;
if (process.argv.includes("--check")) {
  assert.equal(readFileSync(path, "utf8"), bytes);
  console.log(`node.json matches Node profile sync (${captured.length} outcomes)`);
} else {
  writeFileSync(path, bytes);
  console.log(`Wrote node.json from Node profile sync (${captured.length} outcomes)`);
}

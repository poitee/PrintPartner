import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const [root, scenario] = process.argv.slice(2);
const dataDir = join(root, "data");
const receiptPath = join(dataDir, "source-sync-admission.json");
const modulePath = fileURLToPath(new URL("../source-sync-admission.ts", import.meta.url));
const original = fs.readFileSync(
  new URL("../../data/source-sync-ownership.json", import.meta.url),
  "utf8",
);
const loserManifest = join(root, "loser.json");
const winnerManifest = join(root, "winner.json");
fs.writeFileSync(loserManifest, original);
fs.writeFileSync(winnerManifest, scenario === "different" ? `${original}\n` : original);
process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = loserManifest;
let winner;
let winningBytes;
let publications = 0;

// Pause the first process after it observed absence and synced its temporary.
// Let a second real bootstrap publish before resuming the first publication.
const interleave = (publish) => (temporary, destination) => {
  if (destination === receiptPath) {
    publications += 1;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { beginSourceSyncAdmission } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(beginSourceSyncAdmission(process.argv[1])));`,
        dataDir,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PP_SOURCE_SYNC_OWNERSHIP_MANIFEST: winnerManifest },
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    winner = JSON.parse(result.stdout);
    if (scenario === "malformed") fs.writeFileSync(receiptPath, "{broken");
    if (scenario === "nonregular") {
      fs.unlinkSync(receiptPath);
      fs.mkdirSync(receiptPath);
    } else {
      winningBytes = fs.readFileSync(receiptPath, "utf8");
    }
  }
  return publish(temporary, destination);
};
fs.renameSync = interleave(fs.renameSync);
fs.linkSync = interleave(fs.linkSync);
syncBuiltinESMExports();

const { beginSourceSyncAdmission, OwnershipAdmissionError } = await import(modulePath);
let admitted;
let failure;
try {
  admitted = beginSourceSyncAdmission(dataDir);
} catch (error) {
  failure = error;
}
assert.equal(publications, 1);
if (scenario === "same") {
  assert.equal(failure, undefined);
  assert.deepEqual(admitted, winner);
  assert.notEqual(admitted.worker_pid, process.pid);
} else {
  assert.ok(failure instanceof OwnershipAdmissionError);
  assert.equal(failure.code, scenario === "different" ? "restart_manifest_changed" : "malformed");
}
if (scenario === "nonregular") assert.ok(fs.lstatSync(receiptPath).isDirectory());
else assert.equal(fs.readFileSync(receiptPath, "utf8"), winningBytes);
assert.deepEqual(fs.readdirSync(dataDir), ["source-sync-admission.json"]);
console.log(`Preserved concurrent ${scenario} admission`);

import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { digest, json, object, type Json } from "../desktop-parity/model.mjs";
import { canonicalInputs } from "./inputs.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.env.PP_PROGRESS_PARITY_RECEIPTS ?? join(root, "progress-parity-receipts"));
mkdirSync(output, { recursive: true });
const runner = fileURLToPath(new URL("./run.mts", import.meta.url));
function verifyInputs(receipt: { [key: string]: Json }) {
  const hashes = object(receipt.sourceHashes);
  assert.deepEqual(Object.keys(hashes).sort(), canonicalInputs(root), "Exact canonical input path set required");
  for (const [path, hash] of Object.entries(hashes)) assert.equal(digest(readFileSync(join(root, path))), hash, path);
}
before(() => {
  assert(process.env.CARGO_TARGET_DIR, "Set an owned CARGO_TARGET_DIR");
  assert.equal(process.version, "v22.23.3");
  const build = spawnSync("cargo", ["build", "--locked", "--manifest-path", join(root, "rust/Cargo.toml"), "-p", "pp-storage", "--bin", "progress-parity-prepare", "--bin", "required-unit-fixture", "--bin", "checkoff-progress-fixture"], { encoding: "utf8", env: { ...process.env, CARGO_BUILD_JOBS: "2" }, timeout: 300_000 });
  assert.equal(build.status, 0, build.stderr);
});
test("ticket_t_10_fixtures_current_required_progress_domain", () => {
  const paired = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", runner, output], { encoding: "utf8", timeout: 120_000 });
  assert.equal(paired.status, 0, `${paired.stdout}\n${paired.stderr}`);
  const receipt = object(json(JSON.parse(readFileSync(join(output, "parity.json"), "utf8"))));
  assert.equal(receipt.cases, 29);
  assert.equal(receipt.operations, 61);
  assert.deepEqual(receipt.projectionComparisons, { mutation: 37, reopened: 17 });
  assert.deepEqual(receipt.projectionControls, ["remaining-count", "unit-flag", "reopened-progress"]);
  assert.equal(receipt.nodeStartup35, "refused");
  assert.deepEqual(receipt.controls, ["response", "database", "files", "case-count"]);
  verifyInputs(receipt);
  const wrong = structuredClone(receipt);
  object(wrong.sourceHashes)["rust/crates/pp-storage/data/schema.json"] = "0".repeat(64);
  assert.throws(() => verifyInputs(wrong), /schema.json/);
  const omitted = structuredClone(receipt);
  delete object(omitted.sourceHashes)["rust/crates/pp-storage/data/schema.json"];
  assert.throws(() => verifyInputs(omitted), /Exact canonical input path set required/);
  const omittedRunner = structuredClone(receipt);
  delete object(omittedRunner.sourceHashes)["web/scripts/progress-parity/run.mts"];
  assert.throws(() => verifyInputs(omittedRunner), /Exact canonical input path set required/);
  const extra = structuredClone(receipt);
  object(extra.sourceHashes)["unexpected-fixture-input.txt"] = "0".repeat(64);
  assert.throws(() => verifyInputs(extra), /Exact canonical input path set required/);
});
test("original_startup_metadata_mismatch_remains_visible", () => {
  const control = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", runner, output, "--startup-control"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(control.status, 1, `${control.stdout}\n${control.stderr}`);
  assert.match(control.stderr, /original startup metadata parity control.*sqlite_sequence/);
  const receipt = object(json(JSON.parse(readFileSync(join(output, "startup-mismatch.json"), "utf8"))));
  assert.equal(receipt.rustWriterOpens, 2);
  assert.equal(receipt.rawNodeConnections, 2);
  assert.notDeepEqual(object(receipt.node).sqlite_sequence, object(receipt.rust).sqlite_sequence);
});

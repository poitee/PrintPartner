import assert from "node:assert/strict";
import process from "node:process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import { sha256, verifyFreshness } from "./freshness.mjs";

const web = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = join(repo, "rust/crates/pp-contracts/Cargo.toml");
const base = process.argv[2] ?? tmpdir();
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "pp-contracts-run-"));
const cargo = process.env.CARGO ?? "cargo";
const checks = [];
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => item.name === "target" || item.name === "node_modules" ? [] : item.isDirectory() ? files(join(directory, item.name)) : [join(directory, item.name)]);
}
const sourceFiles = [...files(join(repo, "rust/crates/pp-contracts")), ...files(join(web, "scripts/desktop-contracts")), join(web, "packages/contracts/src/plan-drafts.ts"), join(web, "packages/contracts/test-fixtures/desktop/autosave-v1.json"), join(web, "package.json"), join(web, "package-lock.json"), join(repo, "rust/Cargo.toml"), join(repo, "rust/Cargo.lock"), join(repo, "rust/scripts/check-boundaries.py")];
const sources = Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(path))]));
let failure;
function run(name, executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", env: { ...process.env, PP_CONTRACT_RECEIPTS: output } });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}`;
  writeFileSync(join(output, `${name}.log`), log);
  checks.push({ name, executable, args, cwd, exit: result.status, log: `${name}.log`, sha256: sha256(log) });
  assert.equal(result.status, 0, `${name}: ${log}`);
  process.stdout.write(`${name}: exit 0\n`);
}
try {
  run("schemas", process.execPath, ["--conditions=development", "--import", "tsx", "scripts/desktop-contracts/generate.mjs", "--check", output], web);
  run("node-text-tests", process.execPath, ["--conditions=development", "--import", "tsx", "--test", "scripts/desktop-contracts/text.test.mjs"], web);
  run("rust-test", cargo, ["+1.99.0", "test", "--manifest-path", manifest, "--locked"], repo);
  run("rust-parity", cargo, ["+1.99.0", "run", "--manifest-path", manifest, "--locked", "--bin", "contract-parity", "--", join(output, "node-cases.json"), join(output, "rust-cases.json")], repo);
  run("boundary", "python3", ["rust/scripts/check-boundaries.py", "--self-test"], repo);
  run("rust-fmt", cargo, ["+1.99.0", "fmt", "--manifest-path", manifest, "--check"], repo);
  run("rust-clippy", cargo, ["+1.99.0", "clippy", "--manifest-path", manifest, "--locked", "--all-targets", "--", "-D", "warnings"], repo);
  run("negative-controls", process.execPath, ["--test", "scripts/desktop-contracts/controls.test.mjs"], web);
  const report = JSON.parse(readFileSync(join(output, "rust-cases.json"), "utf8"));
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.cases.filter((item) => item.collection === "cases").length, 41);
  assert.equal(report.cases.filter((item) => item.collection === "supplemental").length, 26);
  assert.equal(report.route_receipts.length, 5);
} catch (error) {
  failure = error;
} finally {
  writeFileSync(join(output, "checks.json"), `${JSON.stringify(checks, null, 2)}\n`);
  const artifacts = Object.fromEntries(readdirSync(output).map((name) => [name, sha256(readFileSync(join(output, name)))]));
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify({ status: failure ? "ISSUES" : "PASS", sources, artifacts, versions: { node: process.version } }, null, 2)}\n`);
  verifyFreshness(output);
  process.stdout.write(`Receipts: ${output}\n`);
}
if (failure) throw failure;
process.stdout.write("PASS: 41 frozen cases, 26 supplemental cases and five receipts match; per-run evidence remains independently verifiable\n");

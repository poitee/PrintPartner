import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, verifyFreshness } from "../desktop-contracts/freshness.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const web = join(repo, "web");
const mode = process.argv[2];
assert(["--write", "--check"].includes(mode), "Usage: run.mjs --write|--check [RECEIPTS]");
const receipts = process.argv[3] ?? mkdtempSync(join(tmpdir(), "pp-rust-contracts-"));
mkdirSync(receipts, {recursive: true});
const checks = [];
function run(name, executable, args, cwd = repo) {
  const result = spawnSync(executable, args, {cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
  writeFileSync(join(receipts, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  checks.push({name, args, exit: result.status});
  writeFileSync(join(receipts, "checks.json"), JSON.stringify(checks, null, 2) + "\n");
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
}
const sourcePaths = [
  "rust/Cargo.lock", "rust/crates/pp-domain/Cargo.toml", "rust/crates/pp-domain/src/lib.rs", "rust/crates/pp-domain/src/schema.rs",
  "rust/crates/pp-api-types/tests/ticket_t_63_contracts.rs", "rust/crates/pp-api-types/Cargo.toml", "rust/crates/pp-api-types/src/autosave.rs", "rust/crates/pp-api-types/src/contracts.rs", "rust/crates/pp-api-types/src/bin/export-rust-contracts.rs",
  "web/package-lock.json", "web/packages/contracts/test-fixtures/t9/semantics.json", "web/packages/contracts/test-fixtures/desktop/autosave-v1.json",
  ...readdirSync(join(web, "scripts/rust-contracts")).map((name) => `web/scripts/rust-contracts/${name}`),
];
const sourceHashes = () => Object.fromEntries(sourcePaths.map((path) => [join(repo, path), sha256(readFileSync(join(repo, path)))]));
let sources = mode === "--check" ? sourceHashes() : null;

const cargo = process.env.CARGO ?? "cargo";
const schema = join(web, "scripts/rust-contracts/schemas.json");
const output = join(web, "scripts/rust-contracts/generated.ts");
run("rust-export", cargo, ["run", "--locked", "--manifest-path", "rust/Cargo.toml", "-p", "pp-api-types", "--features", "codegen", "--bin", "export-rust-contracts", "--", mode, schema]);
run("zod-generation", process.execPath, ["scripts/rust-contracts/generate.mjs", mode, schema, output], web);
if (mode === "--check") {
  run("old-t9-semantic-oracle", process.execPath, ["--conditions=development", "--import", "tsx", "--test", "scripts/desktop-contracts/semantics.test.mjs"], web);
  run("old-t9-autosave-oracle", process.execPath, ["--conditions=development", "--import", "tsx", "scripts/desktop-contracts/generate.mjs", "--check", receipts], web);
  const original = JSON.parse(readFileSync(join(receipts, "node-cases.json"), "utf8")).supplemental;
  const frozen = JSON.parse(readFileSync(join(web, "scripts/rust-contracts/supplemental.json"), "utf8")).cases;
  assert.equal(original.length, 50);
  assert.deepEqual(frozen, original.map(({name, parser, raw_input, input, outcome}) => ({name, parser, ...(raw_input ? {raw_input} : {input}), outcome})), "Shared T9 supplemental corpus drift");
  run("generated-parity-controls", process.execPath, ["--conditions=development", "--import", "tsx", "--test", "scripts/rust-contracts/semantics.test.mjs"], web);
  run("generated-typecheck", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "es2023", "--lib", "es2024", "--module", "nodenext", "--moduleResolution", "nodenext", "scripts/rust-contracts/generated.ts"], web);
  run("native-independent-parity", cargo, ["nextest", "run", "--locked", "--manifest-path", "rust/Cargo.toml", "--no-tests=fail", "-p", "pp-api-types", "--features", "codegen", "-E", "test(ticket_t_63_contracts)"]);
}
sources ??= sourceHashes();
const artifacts = Object.fromEntries(readdirSync(receipts).filter((name) => name !== "manifest.json").map((name) => [name, sha256(readFileSync(join(receipts, name)))]));
writeFileSync(join(receipts, "manifest.json"), JSON.stringify({status: "PASS", mode, sources, artifacts}, null, 2) + "\n");
verifyFreshness(receipts);
console.log(`PASS: Rust reverse-generation ${mode}; receipts ${receipts}`);

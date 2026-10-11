import assert from "node:assert/strict";
import process from "node:process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { sha256, verifyFreshness } from "./freshness.mjs";

const receipts = process.env.PP_CONTRACT_RECEIPTS;
assert(receipts, "Run controls through contracts:verify so actual Node cases exist");
const corpus = JSON.parse(readFileSync(join(receipts, "node-cases.json"), "utf8"));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
function detects(change) {
  const input = globalThis.structuredClone(corpus);
  change(input);
  const temporary = mkdtempSync(join(tmpdir(), "pp-contract-negative-"));
  try {
    const path = join(temporary, "cases.json");
    writeFileSync(path, JSON.stringify(input));
    const result = spawnSync(process.env.CARGO ?? "cargo", ["run", "--manifest-path", join(repo, "rust/crates/pp-contracts/Cargo.toml"), "--locked", "--bin", "contract-parity", "--", path, join(temporary, "result.json")], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert(JSON.parse(readFileSync(join(temporary, "result.json"), "utf8")).mismatches.length > 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
const request = (input) => input.cases.find((row) => row.name === "quantity-null-reset");
test("missing required nullable field cannot pass parity", () => detects((input) => { delete request(input).input.decisions[0].target.source_layer; }));
test("strict object drift cannot pass parity", () => detects((input) => { request(input).input.extra = true; }));
test("unknown choice discriminator cannot pass parity", () => detects((input) => { request(input).input.decisions[0].kind = "set_other"; }));
test("Unicode 1001 scalar bound cannot pass parity", () => detects((input) => { request(input).input.decisions[0].target.source_layer = "🙂".repeat(1001); }));
test("relaxed relational expectation cannot pass parity", () => detects((input) => {
  for (const name of ["empty-base-version-mismatch", "revision-base-version-zero", "observed-consumed-draft", "observed-draft-base-mismatch", "duplicate-field"]) {
    const row = input.cases.find((item) => item.name === name);
    row.outcome = { kind: "accepted", parsed: row.input };
  }
}));
test("changed receipt identity cannot pass exact output comparison", () => detects((input) => { input.cases.find((row) => row.name === "receipt-valid").input.revision_id += 1; }));
test("malformed scalar text cannot be waived as accepted", () => detects((input) => {
  const row = input.supplemental.find((item) => item.name === "source_layer-lone-high");
  row.outcome = { kind: "accepted", parsed: {} };
}));
test("modified per-run receipt fails freshness audit", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pp-contract-freshness-"));
  try {
    writeFileSync(join(temporary, "proof.log"), "original");
    writeFileSync(join(temporary, "manifest.json"), JSON.stringify({ status: "PASS", sources: {}, artifacts: { "proof.log": sha256("original") } }));
    assert.equal(verifyFreshness(temporary).status, "PASS");
    writeFileSync(join(temporary, "proof.log"), "changed");
    assert.throws(() => verifyFreshness(temporary), /Receipt changed/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

function withSchemaCopy(check) {
  const temporary = mkdtempSync(join(tmpdir(), "pp-schema-drift-"));
  try {
    const web = join(repo, "web");
    const scripts = join(temporary, "scripts/desktop-contracts");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["generate.mjs", "refinements.mjs", "boundary-adapters.json"]) cpSync(join(web, "scripts/desktop-contracts", name), join(scripts, name));
    cpSync(join(web, "scripts/desktop-contracts/schemas"), join(scripts, "schemas"), { recursive: true });
    cpSync(join(web, "package.json"), join(temporary, "package.json"));
    symlinkSync(join(web, "node_modules"), join(temporary, "node_modules"), "dir");
    symlinkSync(join(web, "packages"), join(temporary, "packages"), "dir");
    const generate = (mode) => spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", join(scripts, "generate.mjs"), mode, join(temporary, "receipts")], { cwd: temporary, encoding: "utf8" });
    check(scripts, generate);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test("actual schema check rejects committed schema drift without refreshing it", () => withSchemaCopy((scripts, generate) => {
  const changed = join(scripts, "schemas/save-request.input.schema.json");
  const schema = JSON.parse(readFileSync(changed, "utf8"));
  schema.additionalProperties = true;
  writeFileSync(changed, JSON.stringify(schema));
  const before = readFileSync(changed, "utf8");
  const result = generate("--check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Schema drift: save-request.input.schema.json/);
  assert.equal(readFileSync(changed, "utf8"), before);
}));

test("obsolete schemas fail check and are removed before DTO regeneration", () => withSchemaCopy((scripts, generate) => {
  const obsolete = join(scripts, "schemas/removed-contract.input.schema.json");
  writeFileSync(obsolete, JSON.stringify({ type: "string" }));
  const checked = generate("--check");
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /Obsolete schema artifact: removed-contract.input.schema.json/);
  assert(existsSync(obsolete), "Check mode must not delete the artifact");
  const written = generate("--write");
  assert.equal(written.status, 0, written.stderr);
  assert(!existsSync(obsolete), "Write mode must remove obsolete schemas before the Rust generator scans the directory");
  assert.equal(generate("--check").status, 0);
}));

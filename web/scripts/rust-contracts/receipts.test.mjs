import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import test from "node:test";
import { sourcePaths } from "./sources.mjs";
import { sha256, verifyFreshness } from "../desktop-contracts/freshness.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
for (const path of [
  "rust/Cargo.toml",
  "web/scripts/desktop-contracts/freshness.mjs",
  "web/scripts/desktop-contracts/semantics.test.mjs",
  "web/scripts/desktop-contracts/generate.mjs",
  "web/scripts/desktop-contracts/refinements.mjs",
  "web/packages/contracts/src/plan-drafts.ts",
]) test(`ticket_t_63_contracts_receipt_detects_source_drift: ${path}`, () => {
  assert(sourcePaths(repo).includes(path), `Missing executable source ${path}`);
  const directory = mkdtempSync(join(tmpdir(), "pp-receipt-control-"));
  try {
    const source = join(directory, "source");
    const bytes = readFileSync(join(repo, path));
    writeFileSync(source, bytes);
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({status: "PASS", sources: {[source]: sha256(bytes)}, artifacts: {}}));
    assert.equal(verifyFreshness(directory).status, "PASS");
    writeFileSync(source, Buffer.concat([bytes, Buffer.from("\nplanted source drift\n")]));
    assert.throws(() => verifyFreshness(directory), /Source changed:/);
  } finally { rmSync(directory, {recursive: true}); }
});

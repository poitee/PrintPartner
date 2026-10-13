import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "pp-wire-regenerate-"));
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit" });
  assert.equal(result.status, 0, `Regeneration failed: ${executable}`);
}
try {
  run(process.execPath, ["--conditions=development", "--import", "tsx", "scripts/desktop-contracts/generate.mjs", "--write", output], web);
  run(process.env.CARGO ?? "cargo", ["run", "--locked", "--manifest-path", "rust/Cargo.toml", "-p", "pp-api-types", "--features", "codegen", "--bin", "generate-wire-dtos", "--", "--write"], repo);
} finally {
  rmSync(output, { recursive: true, force: true });
}

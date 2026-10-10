import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compare, json } from "./model.mjs";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const goldenPath = fileURLToPath(new URL("../../packages/contracts/test-fixtures/desktop/autosave-v1.json", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pp-parity-verify-"));
try {
  const captures = [join(root, "a.json"), join(root, "b.json")];
  for (const capture of captures) {
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "scripts/desktop-parity/capture.mts", capture], { cwd: webRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
  }
  const load = (path: string) => json(JSON.parse(readFileSync(path, "utf8")));
  compare(load(captures[0]), load(captures[1]));
  compare(load(goldenPath), load(captures[0]));
  const tests = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--test", "scripts/desktop-parity/compare.test.mts"], { cwd: webRoot, encoding: "utf8" });
  process.stdout.write(tests.stdout);
  assert.equal(tests.status, 0, tests.stderr);
  process.stdout.write("PASS: two independent captures match each other and the golden; deliberate contract drift rejected\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

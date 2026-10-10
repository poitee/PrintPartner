import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const temporary = mkdtempSync(join(tmpdir(), "pp-contract-schema-"));
try {
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", fileURLToPath(new URL("generate.mjs", import.meta.url)), "--check", temporary], { stdio: "inherit" });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

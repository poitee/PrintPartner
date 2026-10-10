import assert from "node:assert/strict";
import process from "node:process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function verifyFreshness(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  for (const [path, expected] of Object.entries(manifest.sources)) assert.equal(sha256(readFileSync(path)), expected, `Source changed: ${path}`);
  for (const [path, expected] of Object.entries(manifest.artifacts)) assert.equal(sha256(readFileSync(join(directory, path))), expected, `Receipt changed: ${path}`);
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], "Usage: freshness.mjs RECEIPT-DIRECTORY");
  const manifest = verifyFreshness(process.argv[2]);
  assert.equal(manifest.status, "PASS");
  process.stdout.write("PASS: source and per-run receipt hashes are fresh\n");
}

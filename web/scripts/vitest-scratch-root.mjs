// Vitest globalSetup: run the suite with its own empty temp dir and fail the
// run if any test leaves files behind there (GRE-840). Workers spawn after
// this runs, so os.tmpdir() in every test resolves to the per-run root.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// Reusable caches that Node and tsx keep in the temp dir; not test scratch.
const CACHES = [/^node-compile-cache$/, /^tsx-\d+$/];
const KEYS = ["TMPDIR", "TMP", "TEMP"];

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "pp-vitest-scratch-"));
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) process.env[key] = root;
  return () => {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    const leftovers = readdirSync(root).filter((name) => !CACHES.some((cache) => cache.test(name)));
    rmSync(root, { recursive: true, force: true });
    if (leftovers.length > 0) {
      // Vitest logs a teardown throw but still exits 0, so set the code too.
      process.exitCode = 1;
      throw new Error(`test run leaked scratch: ${leftovers.sort().join(", ")}`);
    }
  };
}

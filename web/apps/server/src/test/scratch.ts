import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * Creates a directory under the OS temp dir and removes it when the current
 * test finishes, whether it passed or failed. Call it inside a test body.
 */
export function scratchDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

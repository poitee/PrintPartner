import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFileBufferUnderRoot,
  readFileUnderRoot,
  resolvedFileUnderRoot,
} from "./secure-path.js";

describe("domain secure paths", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it("reads regular files inside the root as text and bytes", () => {
    const root = tempDir("pp-domain-path-");
    const nested = join(root, "nested");
    mkdirSync(nested);
    const file = join(nested, "plan.json");
    writeFileSync(file, "{\"ok\":true}");

    expect(resolvedFileUnderRoot(root, file)).toBe(realpathSync(file));
    expect(readFileUnderRoot(root, file)).toBe("{\"ok\":true}");
    expect(readFileBufferUnderRoot(root, file)).toEqual(Buffer.from("{\"ok\":true}"));
  });

  it("rejects traversal, sibling-prefix paths, missing files, and directories", () => {
    const parent = tempDir("pp-domain-boundary-");
    const root = join(parent, "exports");
    const sibling = join(parent, "exports-private");
    mkdirSync(root);
    mkdirSync(sibling);
    const secret = join(sibling, "secret.txt");
    writeFileSync(secret, "secret");

    expect(resolvedFileUnderRoot(root, join(root, "..", "exports-private", "secret.txt"))).toBeNull();
    expect(resolvedFileUnderRoot(root, secret)).toBeNull();
    expect(resolvedFileUnderRoot(root, join(root, "missing.txt"))).toBeNull();
    expect(resolvedFileUnderRoot(root, root)).toBeNull();
  });

  it("rejects a symlinked file that resolves outside the root", () => {
    const parent = tempDir("pp-domain-symlink-");
    const root = join(parent, "exports");
    mkdirSync(root);
    const secret = join(parent, "secret.txt");
    const link = join(root, "manifest.json");
    writeFileSync(secret, "secret");
    symlinkSync(secret, link);

    expect(resolvedFileUnderRoot(root, link)).toBeNull();
    expect(() => readFileUnderRoot(root, link)).toThrow(
      "Path must be a file under the export directory",
    );
  });
});

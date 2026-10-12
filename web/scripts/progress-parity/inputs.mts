import assert from "node:assert/strict";
import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const trees = ["web/apps/server/src", "web/packages/contracts/src", "web/packages/domain/src", "web/scripts/desktop-parity", "web/scripts/progress-parity", "rust/crates/pp-storage/src", "rust/crates/pp-storage/data", "rust/crates/pp-contracts/src", "rust/crates/pp-api-types/src", "rust/crates/pp-storage/tests/fixtures"];
const files = ["web/package.json", "web/package-lock.json", "web/tsconfig.base.json", "web/packages/contracts/package.json", "web/packages/domain/package.json", "web/apps/server/package.json", "rust-toolchain.toml", "rust/Cargo.toml", "rust/Cargo.lock", "rust/crates/pp-storage/Cargo.toml", "rust/crates/pp-contracts/Cargo.toml", "rust/crates/pp-api-types/Cargo.toml"];

/** Derive the required set from the checkout, never from a supplied receipt. */
export function canonicalInputs(root: string): string[] {
  const paths = [...files];
  function visit(path: string) {
    const entry = lstatSync(path);
    assert(!entry.isSymbolicLink(), `Input tree must not escape through a symlink: ${path}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else {
      assert(entry.isFile(), `Unsupported input type: ${path}`);
      paths.push(relative(root, path));
    }
  }
  for (const tree of trees) visit(join(root, tree));
  for (const file of files) assert(lstatSync(join(root, file)).isFile(), `Required input missing: ${file}`);
  assert.equal(new Set(paths).size, paths.length, "Canonical input set contains duplicate paths");
  return paths.sort();
}

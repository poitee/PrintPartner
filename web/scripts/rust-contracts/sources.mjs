import { readdirSync } from "node:fs";
import { join } from "node:path";

export function sourcePaths(repo) {
  function files(directory) {
    return readdirSync(join(repo, directory), {withFileTypes: true}).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? files(path) : [path];
    });
  }
  return [
    "rust/Cargo.toml", "rust/Cargo.lock", "rust-toolchain.toml",
    ".github/workflows/desktop-contracts.yml",
    "rust/crates/pp-domain/Cargo.toml", "rust/crates/pp-api-types/Cargo.toml",
    "web/package.json", "web/package-lock.json",
    "web/packages/contracts/test-fixtures/desktop/autosave-v1.json",
    ...[
      "rust/crates/pp-domain/src", "rust/crates/pp-api-types/src", "rust/crates/pp-api-types/tests",
      "web/packages/contracts/src", "web/packages/contracts/test-fixtures/t9",
      "web/scripts/desktop-contracts", "web/scripts/rust-contracts",
    ].flatMap(files),
  ];
}

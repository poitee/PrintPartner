# Release

This page will describe how Print Partner builds, signs and publishes each release. It is a stub until the release milestone lands.

## Today

A tag that matches `v*.*.*` starts `.github/workflows/release.yml`. The workflow runs the web quality checks and the manifest validation. Then it builds the Node Docker image, pushes it to `ghcr.io/poitee/print-partner` and creates the GitHub Release. [Release history](../CHANGELOG.md) lists past releases. [Operations](../OPERATIONS.md) describes upgrades.

## Check health parity fixtures

Before tagging a release, after updating the app version or release metadata:

1. Use Node 22.x and npm 10 or later, then run `npm --prefix web ci` from the
   repository root.
2. Regenerate the version-pinned health snapshot:

   ```sh
   node --conditions=development fixtures/parity/auth-health/generate.mjs
   ```

3. Review the diff in `fixtures/parity/auth-health/node.json` and commit the
   expected version or release changes with the version bump. Only Node's
   runtime version is normalized. Investigate unrelated response changes before
   accepting a new snapshot.
4. Run the freshness check and the Rust comparison in both feature modes:

   ```sh
   node --conditions=development fixtures/parity/auth-health/generate.mjs --check
   CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --test auth_health_parity
   CARGO_BUILD_JOBS=3 cargo test --manifest-path rust/Cargo.toml --locked -p pp-api --test auth_health_parity --features desktop_rebuild
   ```

The generator must report `auth health: 6 registered-handler cases passed`.
The Rust suite also checks freshness through `node_health_snapshot_is_current`.
See the [Rust test prerequisites](../rust/README.md#run-pp-api-health-parity-tests)
for native-module runtime selection and the [fixture contract](../fixtures/parity/auth-health/README.md)
for intentional differences. Fixes to production health behavior require a
separate change.

## Target

- macOS first, as signed and notarized DMGs.
- Windows installers and Linux packages before 1.0.
- Signed updates that refuse an unsafe schema change.
- The single-user Rust Docker image.

## To be written

- How to cut a release and who approves it.
- How signing keys are held and rotated.
- How the updater checks schema compatibility and recovers.
- The startup, memory and idle-CPU measurements for each release.

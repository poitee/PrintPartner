# Release

This page will describe how Print Partner builds, signs and publishes each release. It is a stub until the release milestone lands.

## Today

A tag that matches `v*.*.*` starts `.github/workflows/release.yml`. The workflow runs the web quality checks and the manifest validation. Then it builds the Node Docker image, pushes it to `ghcr.io/poitee/print-partner` and creates the GitHub Release. [Release history](../CHANGELOG.md) lists past releases. [Operations](../OPERATIONS.md) describes upgrades.

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

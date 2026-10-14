# GRE-626 CI reconciliation

This record reconciles the CI changes in [PR #155](https://github.com/poitee/PrintPartner/pull/155) with main at `164db7d0bfe46d53ffbbdb3398bff36d5d448b30`.
The source branch ends at `3d4f177a0221e4e8eb4f50d2d58d959be0969f4c`.
`git cherry` reports different patch identities, so each change was compared by behavior rather than cherry-picked wholesale.

## Commit decisions

Every source commit below is dropped. Existing implementations cover the marker-counting behavior. The remaining workflow changes duplicate checks or broaden hosted CI, contrary to GRE-626's local-first constraint.

| Source commit | Decision and evidence on main |
| --- | --- |
| `1f2ba05e78399ebc1430d493efa76714b92a4634` | Drop. `79b69701` introduced the workaround check. Web CI already runs the check and its tests. The manual `chain-tip-gate.yml` already runs `cargo clippy --locked --workspace --all-targets -- -D warnings` after installing desktop libraries. Automatic Desktop runtime still lints selected backend crates. Extending that hosted job to every crate and adding desktop libraries is deliberately declined here. The proposed workspace lint table restates Clippy's default groups and levels, so its per-crate inheritance adds no stricter policy. Adding workaround path triggers would launch another hosted workflow for changes already covered by Web CI. |
| `dde8462f7a616fe7dd4681a00e588d3779f746f5` | Drop. `66fae662` already counts markers in block comments and refuses baseline increases during `--update`. Main tests cover both behaviors. Web CI runs those tests for its matched paths. A Desktop runtime invocation would add Rust-only coverage, which is explicitly declined below under the local-first constraint. |
| `ca9828fa470cea649a9c1a84ed21d434e57474df` | Drop. `bddb722e` and `122e7ba0` already count shell and YAML markers conservatively. `countText` counts every physical shell and YAML line. Rust whitespace and multiline attributes have dedicated tests on main. |
| `8984efa5c42aea60a034216ae17ef743eeb2f7b3` | Drop. Main already has `countRustAllowMarkers` and `countRustAllowMeta`, including nested `cfg_attr` handling. Tests restrict counts to emitted lint attributes. Main requires no direct YAML parser dependency because every YAML line is counted. Manifest changes already trigger Web CI. Adding manifest triggers to hosted Desktop runtime is deliberately declined. |
| `f7924d1906a3ebe5b148b4a2ae64e98c4bffdd65` | Drop. `122e7ba0` already counts every physical YAML line without parsing. Main has no direct `yaml` dependency in `web/package.json`. |
| `c86841dc151bc72602c8c24a53e04cdb8ca5f586` | Drop. This sixth relevant commit follows the five cited in the ticket. `5681bbde` already counts HTML markers once per key per physical line, including text and attributes. Main has the corresponding tests. |

Main also has later protections for Rust raw C strings, unterminated strings, and nested block-comment recovery. Copying the older source implementation would remove those protections.

## Scope and verification

[PR #133](https://github.com/poitee/PrintPartner/pull/133) already merged catalog writes, durable jobs, and accepted-plan reads with storage ownership and Auth policy. Those inherited application changes are outside this CI reconciliation. This record neither ports nor reverses them.

The documentation is the complete D31 change. It adds no workflow, runner, dependency, or product behavior. No feature flag is needed. The missing automatic whole-workspace lint scope and extra Desktop runtime triggers are explicitly dropped, not claimed as present.

Web CI does not trigger for a Rust-only change. Such a change therefore lacks an automatic run of the workaround check. Adding the check to hosted Desktop runtime would close that gap, but that expansion is also deliberately dropped under the local-first constraint. The existing command remains available for local verification. The manual chain-tip gate's final summary fails if Clippy fails, despite the Clippy step's `continue-on-error` setting.

Run the existing checks from the repository root after installing the web dependencies:

```sh
node scripts/workaround-ratchet.mjs
node --test scripts/workaround-ratchet.test.mjs
git diff --check
```

Reproduce the comparison with:

```sh
git fetch origin refs/heads/main refs/pull/155/head:refs/triage/gre-626/pr-155
test "$(git rev-parse refs/triage/gre-626/pr-155)" = 3d4f177a0221e4e8eb4f50d2d58d959be0969f4c
git cherry 164db7d0bfe46d53ffbbdb3398bff36d5d448b30 refs/triage/gre-626/pr-155
git diff 164db7d0bfe46d53ffbbdb3398bff36d5d448b30 refs/triage/gre-626/pr-155 -- scripts/workaround-ratchet.mjs scripts/workaround-ratchet.test.mjs .github/workflows/desktop-runtime.yml rust/Cargo.toml 'rust/crates/*/Cargo.toml' web/package.json web/package-lock.json web/scripts/workaround-yaml.mjs
```

The tip assertion prevents a later update to #155 from silently changing this comparison. Use a full clone so main's recorded historical commit is available.

After this record merges under the review and CI gate, close #155 with a comment naming the reconciliation merge SHA. Keep its source branch.

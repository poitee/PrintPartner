# Readiness gap closure

This is the implementation order for the 46 incomplete criteria in the saved
59.3% audit, not a new assessment. See [Missions readiness](missions-readiness.md)
for the snapshot, application inventory, product decisions, and runtime gates.

Target: fully evidenced readiness for the approved Rust/shared React product.
The generic audit also measures capabilities that may be inappropriate for this
product. Do not add analytics, cloud operations, dummy database schemas, or
meaningless health endpoints to satisfy it. A justified exception is not a pass.
Keep the raw audit score separate from product-specific acceptance.

## Implementation order

Each row describes a series of small PRs, not one large change. Preserve
currently passing criteria and require exact-head independent review and green
applicable CI. Work on Rust/shared React first; maintain legacy Node/Python
behavior until approved retirement. Do not remove them from full assessments
while they remain applications.

| Slice | Incomplete audit criteria | Required evidence |
|-------|---------------------------|-------------------|
| 1. Shared instructions and validation | `agents_md`, `skills`, `agents_md_validation`, `gitignore_comprehensive` | This branch supplies instructions, a skill, offline checks, regression tests, and a lightweight CI job. Root instructions and secret-free environment examples are trackable; real environment files stay ignored. Local results are not a hosted CI receipt. |
| 2. Reproducible development environment | `devcontainer`, `unit_tests_runnable` | Add a pinned development container with documented dual Node toolchains and Linux native prerequisites. Build it and execute nonzero tests for supported paths. Report native OS/display and slicer blockers separately. The previously skipped `devcontainer_runnable` criterion must also be revisited, not silently promoted. |
| 3. Formatting and developer hooks | `formatter`, `pre_commit_hooks`, `large_file_detection` | Use maintained formatting/hook tools and the existing Cargo formatter. Establish check-only CI commands and source-file admission limits. Separate mechanical formatting from behavior changes; prove hooks and negative controls, without silently installing hooks on other users' machines. |
| 4. Type and naming safety | `lint_config`, `type_check`, `strict_typing`, `naming_consistency` | Measure shared React strict-type errors; enable strict checks in bounded areas, fix errors rather than suppressing them, then expand. Preserve Node/Python compatibility. New configuration alone is not all-app coverage. |
| 5. Source quality and boundaries | `cyclomatic_complexity`, `dead_code_detection`, `duplicate_code_detection`, `code_modularization`, `heavy_dependency_detection`, `unused_dependencies_detection`, `code_quality_metrics` | Extend existing ESLint/Knip and Rust checks before adding tools. Measure complexity/duplication/dependency baselines; enforce a non-regression gate with reviewed exclusions. Preserve crate boundaries and add frontend boundary checks. Retain machine-readable reports; do not manufacture a dashboard claim. |
| 6. Version and flag lifecycle | `version_drift_detection`, `dead_feature_flag_detection` | Enforce actual toolchain/workspace expectations while explicitly allowing Node 22.23.3 parity versus Node 24.21 runtime. Give temporary flags an owner and retirement condition, detect unused/expired entries, and test negative controls. Never expire `desktop_rebuild` by enabling it automatically. |
| 7. Test quality | `test_performance_tracking`, `flaky_test_detection`, `test_coverage_thresholds` | Retain timing/retry evidence for affected test runners. Measure Rust/React coverage, then enforce a reviewed useful floor or regression policy. Do not set a token zero threshold, exclude most code, or quarantine no-data-loss/no-orphan tests. |
| 8. Contracts and data performance | `api_schema_docs`, `database_schema`, `n_plus_one_detection` | Generate versioned schemas from the actual runtime contracts with reproducibility checks; coordinate with GRE-445. Add realistic query-count/latency regressions for storage operations. Browser/sidecar database ownership must be assessed honestly, not supplied with dummy schemas. |
| 9. Local diagnostics and resilience | `structured_logging`, `health_checks`, `circuit_breakers`, `profiling_instrumentation`, `pii_handling`, `log_scrubbing`, `dast_scanning` | Exercise structured/redacted diagnostics, bounded failure recovery, profiling, and relevant runtime attack/negative cases. Use the existing scrubber and gateway harnesses. No real printer sends, secret logging, or invented standalone-browser server endpoints. Expand legacy checks only where maintenance warrants it. |
| 10. CI throughput | `fast_ci_feedback` | Coordinate with maintainer-owned GRE-1041 instead of duplicating cache/sharding work. Compare representative before/after required-check spans, not one warm build. Correctness, immutable event inputs, and required check names must remain intact. |
| 11. Governance and release evidence | `branch_protection`, `issue_labeling_system`, `deployment_frequency` | Maintainer approves/enables review enforcement and the relevant priority/severity taxonomy. Publishing remains separately authorized. Demonstrate real successful releases over time; adding workflow YAML cannot prove frequency. Linear remains execution authority. |
| 12. Privacy-sensitive observability | `distributed_tracing`, `metrics_collection`, `error_tracking_contextualized`, `alerting_configured`, `deployment_observability`, `product_analytics_instrumentation`, `error_to_insight_pipeline` | Product-owner decision required where the generic rubric conflicts with privacy/offline operation. Prefer local, redacted diagnostics and explicit opt-in Sentry. No analytics or third-party transmission is authorized by this roadmap. Runtime dashboards, alerting, release correlation, and error-to-issue writes need real configuration and observed evidence, not CI alerts or offline perf captures relabeled as passes. |

## Completion gates

- All applicable checks execute on the exact proposed head with nonzero tests
  and meaningful negative controls. Collection, compilation, skipped checks,
  and historical receipts remain distinct.
- Native macOS/Windows/Linux acceptance and signing require the actual platform
  and permission receipts. A Linux development container does not satisfy them.
- Rust operation ownership, recovery, service-client migration, and scoped AI
  remain governed by their existing issues. Readiness tooling does not authorize
  cutover or additional product features.
- External settings, issue/label writes, uploads, publishing, and actual product
  default changes still require explicit authorization.
- A fresh full assessment retains all 84 criteria and all current applications,
  explains applicability consistently, and stores only evidence-backed results.
  Keep the historical 59.3% report unchanged.

## Current slice

Slice 1 is implemented locally in the readiness worktree. Run `just guidance`
and follow the [CI guide](ci.md#shared-agent-guidance). Its hosted job, independent
review, and merge are still pending. No readiness percentage has been recalculated.

Slice 2 is implemented in a separate development-environment branch, not in
this branch. Its digest-pinned image built and completed the
Dev Container CLI lifecycle on Linux x86-64. The smoke ran five pp-domain tests
with the feature off, ten with it on, and four shared React tests. All passed;
the validation container stopped successfully. This does not prove native
acceptance, application-wide test coverage, or a higher full-audit score.

Both slices need independent review and hosted CI before merge. Respect the
two-slice work-in-progress limit rather than accumulating additional branches.
The next implementation group is formatting and developer hooks after a slice
has cleared review.

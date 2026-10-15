GRE-498 Settings evidence captured through T3 Code preview at source head 0ca43744ef3117ba514a612aba6b37ea6e612c98.

Flag-on screenshot shows the real Settings page with PP_DESKTOP_REBUILD=1, after clicking Print farm and confirming the saved tenant choice through GET /settings/features and a reload. Other three switches retain their false defaults.

Flag-off screenshot shows the real Settings page with PP_DESKTOP_REBUILD=0. The page contains no feature-toggle switches, health omits tenant_feature_toggles, and GET /settings/features returns 404.

Both app instances use isolated temporary SQLite directories. No live printer adapters were exercised. Images captured through preview_snapshot, not a desktop display capture. This evidence branch is not source work and must not be merged.

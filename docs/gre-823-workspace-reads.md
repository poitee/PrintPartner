# GRE-823: wire workspace reads to rebuild endpoints

`PlanWorkspaceProvider` reads `/health` through `useHealthQuery`. When that response includes `tenant_feature_toggles`, the stored `PP_DESKTOP_REBUILD` value is exactly `1` or `true`. An open draft whose base is current supplies `draft.base.revision_id`, and the Plan review query is stored under that revision. A first Plan has no revision id. That empty identity is its own slot. A response whose `accepted_basis.plan_revision_id` does not match is refused and is not retried, so a later revision cannot occupy the earlier slot. A draft whose base is not current keeps the existing review query, so the accepted review still loads. Switching revisions keeps each slot. The review query waits while the draft list is loading, and while an open draft's workspace has not loaded. Until that review arrives, the Plan stays loading.

Applying a draft closes it, then removes those revision slots. The accepted review loads on the existing query. A review stored under a revision is not shown while that load is in flight. A closed draft is not pinned, so that load cannot rebuild the old slot. A pinned slot cannot fail the apply.

Without that capability, including while health is still loading, the review query keeps the existing key and `fetchPlanReview` path. A passed revision id is ignored. Plan failed-save intent stays with GRE-624. Production gateway cutover stays with GRE-593.

```sh
npm run test -w @print-partner/web -- src/queries/planReview.test.tsx src/context/PlanWorkspaceContext.test.tsx src/context/PlanWorkspaceContext.rebuildApply.test.tsx
```

That command runs the existing tests plus `workspace_rebuild_read_keeps_revision_identity`, `workspace_rebuild_read_keeps_unrevised_identity`, `workspace_rebuild_read_does_not_show_a_pinned_review_as_accepted`, `workspace_flag_off_preserves_query_path`, `workspace_rebuild_read_stays_loading_until_the_draft_is_known`, and `workspace_rebuild_apply_does_not_repin_a_closed_draft`.

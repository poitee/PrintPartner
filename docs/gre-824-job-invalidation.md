# GRE-824: invalidate source and plan reads after completed jobs

`JobProvider` reads `/health` through `useHealthQuery`. When that response
includes `tenant_feature_toggles`, the stored `PP_DESKTOP_REBUILD` value is
exactly `1` or `true`. A finished `import-scan` then refreshes the source list,
the source activity feed, and the source content for the source named by the
completion result. `project_id` on that result wins. When the result omits it,
the source id passed at the start is used. The library starts an import scan
as `import-scan` and passes that source id. Another source's content stays
cached. Plan reviews stay cached.

A finished job whose result carries `profile_id`, `draft_id`, and `revision_id`
refreshes that plan's review, layers, drafts, checkoff, workflow, and accepted
plate reads. Another plan stays cached. An export result has no `draft_id`, so
it does not refresh the plan. A finished sync or update check still refreshes
the shared source, profile, and plan review caches. A failed or cancelled job
does not refresh these reads and is not started again.

Without that capability, including while health is still loading, a finished
source job still refreshes every source, every profile, and every plan review.
The accepted plate export history refresh is unchanged. Plan failed-save intent
stays with GRE-624. Production gateway cutover stays with GRE-593.

```sh
npm run test -w @print-partner/web -- src/queries/invalidation.test.ts src/pages/SourcesPage.import-scan.test.tsx
```

That command runs the existing invalidation tests plus
`source_import_completion_invalidates_owned_queries` and
`plan_publication_invalidates_only_matching_plan`.

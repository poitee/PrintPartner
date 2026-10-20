# Orders admission for Plan edits

With `PP_DESKTOP_REBUILD` set to exactly `1` or `true`, `PATCH /plans/:id`
requires Orders access when the payload includes `special_request`. This also
applies to `/api/v1/plans/:id` and `/api/v2/plans/:id`. Null and empty strings
count as writes.

The existing `readFeatureAccess` helper resolves the request tenant's user
settings and the owned Plan's override. A Plan choice overrides the user choice.
Missing choices default to disabled. Each request reads the current settings,
so revocation takes effect on the next write.

After the existing owned Plan read and summary preflight, disabled Orders returns
403 with code `FEATURE_DISABLED` and detail `Feature orders is disabled.`
Invalid stored user or Plan settings return 500 with code
`FEATURE_TOGGLES_INVALID` and detail `Stored feature toggles are invalid.`
Both responses precede every mutation, including name, archive, and last-used
changes in a mixed payload. A foreign or missing Plan keeps the existing 404.

Payloads without `special_request` keep ordinary Plan edit behavior and retain
stored customer requests, even when Orders is disabled or settings are invalid.
Unset and unrecognized flag values keep legacy write behavior without reading
feature settings. Enabled writes keep the existing trimming and clearing rules.

With Node 22 and workspace dependencies installed, run from `web`:

```sh
npm run build -w @print-partner/contracts
npm run build -w @print-partner/domain
npm run test -w @print-partner/server -- src/routes/plan-orders-feature-access.test.ts
npm run typecheck -w @print-partner/server
```

The focused tests use real Fastify requests and disposable SQLite databases.
They cover all three aliases, feature resolution, live revocation, malformed
settings, tenant isolation, legacy flag values, and stored state after denial.

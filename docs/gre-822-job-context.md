# GRE-822: route browser job state through snapshots

`JobProvider` reads `/health` through `useHealthQuery`. When that response
includes `tenant_feature_toggles`, the stored `PP_DESKTOP_REBUILD` value is
exactly `1` or `true`, and the job row follows the socket. A dropped socket
stays on the same subscription. The next frame, including the snapshot after
reconnect, replaces `status`, `message`, and `progress`. HTTP polling does not
run, so a slower read cannot overwrite that frame. `Job not found` still ends
the row.

Without that capability, including while health is still loading, the provider
keeps the existing socket plus HTTP poll. A socket error still leaves the poll
to finish the job. Plan failed-save intent stays with GRE-624. Production
gateway cutover stays with GRE-593.

A lost session during a rebuild job ends the row. `Session expired` and
`Session revoked` call `notifyEngineUnauthorized`. That close handling is
GRE-1001 (`docs/gre-1001-job-session.md`).

```sh
npm run test -w @print-partner/web -- src/context/JobContext.test.tsx
```

That command runs the existing `JobContext` tests plus
`job_context_rebuild_reconnect_uses_snapshot` and
`job_context_flag_off_uses_existing_transport`.

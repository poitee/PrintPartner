# GRE-1001: end the job row when the session socket closes

When health reports `tenant_feature_toggles`, `JobProvider` does not poll
`GET /jobs/{id}`. A 1008 close other than `Job not found` used to stop
reconnects and leave the row running. `stl-export` has no deadline, so that
row stayed until reload.

`connectJobWebSocket` now reports that close once and does not reconnect.
`Session expired` and `Session revoked` call `notifyEngineUnauthorized` and
end the row with the same Lost contact message a 401 poll uses. Any other
1008 reason, and a job socket URL that cannot be built, also ends the rebuild
row. Those cases do not call `notifyEngineUnauthorized`.

`Job not found` still ends the row and does not reconnect. An ordinary close,
including 1006, still reconnects and does not finish the row. A stream error
that will reconnect stays on the subscription. With the capability absent,
the socket plus HTTP poll stays, and a session close still finishes through
the poll.

```sh
npm run test -w @print-partner/web -- src/api/jobWebSocket.test.ts src/context/JobContext.test.tsx
```

That command runs the 1008 session close cases and
`job_context_rebuild_session_loss_ends_the_row`.

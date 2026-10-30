# GRE-410: durable job states on authoritative streams

`JobRecord::snapshot` maps every durable state to one of the contract's five
statuses (`JobStatus` in `web/packages/contracts/src/index.ts`): `queued` is
`pending`; `running` and `effect_admitted` are `running`; `uploaded_only` and
`succeeded` are `done`; `failed` and `reconciliation_required` are `error`;
`cancelled` is `cancelled`. An interrupted attempt has an explicit outcome:

- No effect started: a restart puts the job back to `pending`.
- An effect was admitted and not confirmed: a restart sets
  `reconciliation_required`, which reports `error` with a message naming what
  to check. A printer upload says `Check the printer or Spoolman outcome before
  retrying`. A source check says `Check the previous outcome before retrying`.

With `desktop_rebuild`, a live stream closes `OwnerStopped` when the owner
stops. After restart, every fresh subscription gets that `error` snapshot once,
then closes `Finished`, and `read_public` returns the same snapshot. A
subscriber 16 commits behind closes `Lagged` instead of buffering more; polling
and a resubscription then report the terminal snapshot. Another tenant gets
`NotFound` from both subscribe and poll. Logout closes a stream `Revoked`
before any queued snapshot. The registry holds at most 128 live streams.

Not in this slice: switching route aliases and workers from Node to Rust as
one operation. That cutover stays with GRE-593.

```sh
umask 022
export CARGO_TARGET_DIR=/persist/targets/gre-410-streams
export CARGO_BUILD_JOBS=4
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --no-tests=fail -E 'test(ticket_t_28_streams)'
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --no-tests=fail -E 'test(ticket_t_28_streams)'
```

With the feature off, the filter runs 1 test. With the feature on, it runs 5.

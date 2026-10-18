# Plan publication client parity cases (GRE-858)

`fixtures/parity/plan-publication/clients.mjs` runs Node's real Plan Apply route
against a temporary copy of the fixture database. Each case records the HTTP
result, the stored `plan_apply_requests` receipt, and the actors stored on the
accepted `plan_revisions` row. The Rust test
`plan_publication::tests::client::client_matches_node_apply_route_keys_replay_context_and_error_text`
replays every case and compares its stored values with these Node literals.

## Credentials

Each case has a `credential` field:

- `session`: the request has a session user. Node and Rust store the user ID
  as the actor.
- `api_key`: the request has no session user. Node creates a disposable key with
  `createApiKey` in the temporary database and admits the request with
  `validateApiKey`. Node stores the actor as `tenant:<tenant id>`. The Rust test
  seeds its own disposable key in `api_keys_v1` and publishes with
  `Credential::ApiKey`. The receipt, revision actors, and replay must match the
  Node literal `tenant:default`.

No case uses a real account, key, or Plan.

## Run the checks

Regenerating requires Node 22.18 or newer and `npm --prefix web ci --ignore-scripts`.

```sh
node fixtures/parity/plan-publication/generate.mjs --check
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib plan_publication::tests::client
```

To regenerate `node.json` after a deliberate Node change, run the generator
without `--check`.

A change to the API-key actor in
`auth::authority::queries::reconciliation_actor_ref` must fail the Rust test.
For example, `key:<key id>` or the bare tenant ID both fail.

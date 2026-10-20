# Plan publication client parity cases (GRE-858, GRE-860)

`fixtures/parity/plan-publication/clients.mjs` runs Node's real Plan Apply route
against a temporary copy of the fixture database. Each case records the HTTP
result, the stored `plan_apply_requests` receipt, and the actors stored on the
accepted `plan_revisions` row. The Rust test
`plan_publication::tests::client::client_matches_node_apply_route_keys_replay_context_and_error_text`
replays every case and compares successful receipts and stored values with these Node literals.

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

## Not-found comparison at the Rust client boundary

The `other-tenant` fixture captures Node's HTTP 404 with the complete body
`{"detail":"Plan not found","code":"profile_not_found"}`.
The test-only `node_not_found_outcome` function accepts exactly that status and
body, then normalizes them to `{"kind":"not_found"}`. An unrecognized status,
body field, or body value fails the test. The assertion compares this expectation
with the complete serialized `Outcome` returned by the real `PublicationClient`
call through `run`.

Rust's unit `Outcome::NotFound` contains no HTTP status, detail, or code.
This comparison covers the Rust storage client boundary. It does not exercise a
Rust HTTP response or establish Rust HTTP parity.

The existing client test proves that the foreign Plan exists under `default`
and that the caller belongs to another tenant. The separate
`client_matches_node_not_found_contract_for_missing_plan` test uses positive
profile ID `999999` and proves that no Plan has that ID. Both retain an existing
draft and use the same captured Node not-found contract. The missing-Plan input
is a Rust test case derived from the foreign-Plan fixture, not another captured
Node response.

Each case snapshots every SQLite table before and after `run`, including
`plan_apply_admissions`, `sqlite_sequence`, and unrelated existing rows.
The test reads rows directly through rusqlite and retains owned SQLite values,
including blobs. It sorts rows by every column, compares the table names, then
compares each table's complete rows with a case-specific assertion message.
Existing successful publication and replay assertions remain in place.
GRE-868 policy behavior is outside this test's scope.

Run both client comparisons with this focused command from the repository root.
The prefix selects the existing client matrix and the missing-Plan test.

```sh
umask 022
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache CARGO_TARGET_DIR=/tmp/pp-gre-860-target cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib plan_publication::tests::client::client_matches_node_
```

To verify that the comparison consumes the actual result, insert this temporary
mutation in `assert_client_not_found` after `run` returns and before serialization.
Keep the fixture and `node_not_found_outcome` unchanged.

```rust
let outcome = match outcome {
    Outcome::NotFound => Outcome::BuildArchived,
    other => other,
};
```

Run the focused command again. Both tests must fail at the complete Rust Outcome
assertion, identifying `other-tenant` and `missing-plan` respectively. The actual
value becomes `{"kind":"build_archived"}` while the expected value stays
`{"kind":"not_found"}`. Remove the mutation and rerun the command to confirm both
tests pass. A fixture-only edit or an assertion that compares two expected
literals does not prove that the actual Rust result reaches the assertion.

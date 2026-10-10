# T-9 wire generation and semantic boundaries

`web/packages/contracts` Zod remains the wire-contract owner while Node owns
transactions. `npm run contracts:generate` (from `web`) exports separate draft-7
input/output schemas and regenerates checked-in `pp-api-types/src/generated.rs`
with typify **0.5.0**. This pin is compatible with the workspace's serde_json
1.0.145; generation dependencies are behind the `codegen` feature. Ordinary
builds compile the checked-in DTOs and do not run a generator. The generator
normalizes typify Copy enum reference conversions and omits unused error modules
from primitive-only schemas so generated code passes Clippy without suppressions.

`npm run contracts:verify` regenerates both sets of artifacts, runs
`git diff --exit-code` on them, rejects new untracked artifacts, removes obsolete schemas in write mode (and
rejects them in check mode), and runs the
semantic tests, frozen autosave parity, boundary checks, formatting, Clippy and
negative controls. Commit regenerated artifacts with the authoritative changes.
A stale contract edit must fail verification. The verifier retains logs and
source/artifact hashes in a fresh receipt directory per run.

## Generated types are structural representations

The generated module is private. Downstream consumers use the existing immutable,
validated autosave DTOs through `parse_request`, `parse_identity`, and
`parse_receipt`. These boundaries also validate the original JSON against its
schema and deserialize the normalized value into the generated representation.
Do not expose a raw generated deserializer as a validated domain API.

JSON Schema and typify alone cannot preserve every Zod semantic:

- Required nullable fields can collapse into Serde `Option`. Validate the original
  JSON and the existing required-nullable adapter before constructing the DTO.
- Primitive typify integers reject `1.0`; Zod accepts it. Validate bounds first,
  then normalize through `WireInteger` before generated deserialization.
- Custom refinements are silently omitted by Zod's JSON Schema exporter. Each
  supported check must use `boundaryRefinement` with a reviewed name from
  `boundary-adapters.json`. Plain custom checks, including nested checks, fail
  generation. Zod dates/transforms which cannot be represented also fail explicitly.
- Autosave relational constraints (basis, selected draft and duplicate targets)
  remain in `autosave.rs`. Scalar Unicode is enforced by Node's annotated check
  and Rust's UTF-8 deserialization, as recorded in ADR 0006. Codepoint limits
  preserve Unicode without normalization.
- Defaults are parsing operations, not JSON Schema validation. The shared
  conformance probe explicitly applies an omitted default and strips unknown
  keys before validating output. Null does not trigger the default. This adapter
  is confined to the probe; it does not change a production route.

The existing frozen corpus covers 41 autosave cases; the generator also measures
50 Unicode/integer/date-text cases and five saved route receipts. The shared
`packages/contracts/test-fixtures/t9/semantics.json` adds 34 isolated cases for
optional/null/default/unknown/enums/safe integer limits/calendar dates/Unicode
length/refinements. Both Node and Rust assert accept/reject and exact accepted
JSON against those same expectations. Rust compares the actual generated output
DTO serialization; the autosave boundary also checks its generated serialization
against the validated native wire value. The autosave `applied_at` contract is
bounded text, deliberately not a datetime; the conformance date is a calendar
ISO date. Input/output differences are asserted separately.

## Remaining parent evidence

The reverse schemars-to-Zod proof belongs to the pre-T-63 ownership flip and
must be pinned and run against this corpus before changing the owner. WS/MCP
need protocol fixtures for their actual frames and lifecycle; HTTP schema
coverage cannot establish those protocols. Neither is implied by this generator.
There is no native-command DTO in this operation. When one is introduced, use
**ts-rs 12.0.1** only for that small native DTO; do not add tauri-specta.
Node retains SQL/transaction ownership, route aliases and workers.

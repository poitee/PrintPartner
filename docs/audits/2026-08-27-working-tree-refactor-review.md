# Working-tree refactor review handoff

## Review scope

This review compares the current working tree with `HEAD` at commit
`d6258581d4f3f06b1a52302b764835aae67df273`.

There are no commits after that fixed point. The review includes:

- 190 tracked changed files
- 181 untracked files
- the endpoint extraction
- caller migration away from `api/engine`
- the server and web module seams added during the refactor

The main spec is
`docs/audits/2026-08-25-engine-ts-blast-radius.md`. The review also applies the
project domain language and the TypeScript best-practices rules.

## Resolution

All findings in this handoff were resolved on 2026-08-27:

- multipart, streaming, authentication, and error handling now live behind the
  shared transport interface
- browser file helpers and the job WebSocket adapter are separate from HTTP
  endpoint modules
- proposed actions use a named input object, and the shallow pass-through
  helper was removed
- endpoint tests use one Fastify-backed HTTP fixture that validates request
  bodies, including `FormData`
- the final state is divided into transport, facade, caller, server seam, web
  seam, and test/audit commits

`cd web && npm run quality` passes. An isolated API and Vite run also passed a
browser check of the API-backed Builds and Source Library pages with no console
errors.

## Review result before remediation

Do not merge or commit the working tree as one change yet. The implementation
passes the automated checks, but the review found unresolved standards and spec
issues.

The full verification run passed before this review:

- lint
- typecheck
- 222 test files with 1,666 tests
- 9 workflow smoke tests
- production build
- browser tests
- quality checks

Passing checks do not settle the module design findings below.

## What is already correct

- `web/apps/web/src/api/engine.ts` is now a compatibility facade made of
  re-exports. It contains no endpoint implementation.
- Production callers use narrow endpoint modules instead of the aggregate
  facade.
- Printer claims preserve the verify-first rule. A claim creates an
  `awaiting_verify` link, while manual verification changes progress.
- Accepted-media behavior has an inventory test.
- The refactor adds focused tests around the extracted server and web module
  interfaces.

## Standards findings

### P1: unchecked casts in endpoint tests

These tests cast request bodies to `FormData` without validating the value:

- `web/apps/web/src/api/endpoints/browserFiles.test.ts:33`
- `web/apps/web/src/api/endpoints/sourceArtifacts.test.ts:34`
- `web/apps/web/src/api/endpoints/productionSend.test.ts:34`

Example:

```ts
expect((init?.body as FormData).get("new_name")).toBe("Imported");
```

This breaks the TypeScript rule that casts must follow validation. Use an
`instanceof FormData` check and throw if the body has the wrong type.

### P1: endpoint tests mock runnable HTTP behavior

Twenty-three endpoint test files replace `fetch` with a global mock. Examples
include:

- `web/apps/web/src/api/endpoints/auth.test.ts:16`
- `web/apps/web/src/api/endpoints/jobs.test.ts:10`
- `web/apps/web/src/api/endpoints/sourceContent.test.ts:19`
- `web/apps/web/src/api/endpoints/productionSend.test.ts:14`

The TypeScript testing rule says to use real framework behavior when it can run
locally. Cover endpoint adapters through the Fastify test application where
practical. Keep mocks for browser behavior and failure modes that the local
application cannot produce cleanly.

### P1: positional proposed-action interface

`web/apps/server/src/assistant/proposed-actions.ts:12-19` exposes six positional
parameters:

```ts
proposeAssistantAction(type, planId, label, summary, params, extras)
```

The parameters form a data clump and make call sites depend on ordering. Replace
them with one named input object. This gives the module a smaller, clearer
interface and keeps proposed-action invariants local.

### P2: pass-through `propose` function

`web/apps/server/src/assistant/tools.ts:1735-1743` defines `propose` only to call
`proposeAssistantAction` with the same arguments.

The function is a shallow module. Deleting it removes no complexity. Call the
real module directly, or keep one deeper proposed-action interface that also
owns dismissal checks.

### P2: repeated endpoint test fixtures

`jsonResponse` appears in 23 endpoint tests. `requestBody` appears in 21.
Extract a shared endpoint-test HTTP fixture so request decoding and response
construction have one implementation.

## Spec findings

### P1: transport remains inside endpoint modules

The definition of done says:

> Transport lives only in `engineTransport.ts` / `contractRequest.ts`.

Raw `fetch` calls remain in:

- `web/apps/web/src/api/endpoints/productionSend.ts:107,163,192`
- `web/apps/web/src/api/endpoints/assistant.ts:126`
- `web/apps/web/src/api/endpoints/sourceContent.ts:51`
- `web/apps/web/src/api/endpoints/sourceArtifacts.ts:215,233`
- `web/apps/web/src/api/endpoints/browserFiles.ts:45`
- `web/apps/web/src/api/endpoints/media.ts:55`

Some of these calls omit `credentials: "include"` and bypass centralized 401
handling. This is both a spec gap and a behavior risk when the engine uses a
different origin.

Add transport helpers for multipart uploads and streaming responses. Endpoint
modules should describe product operations. The transport implementation should
stay behind the transport module interface.

### P1: browser behavior is mixed with fetch-only endpoint modules

The definition of done says:

> Browser-only helpers are isolated from fetch-only endpoint modules.

Two modules still mix those responsibilities:

- `web/apps/web/src/api/endpoints/browserFiles.ts:1-57` imports browser file
  pickers and implements an HTTP upload.
- `web/apps/web/src/api/endpoints/jobs.ts:60-102` mixes job HTTP operations with
  `window` and `WebSocket` behavior.

Split the browser adapters and WebSocket adapter from the fetch-only endpoint
modules. Preserve the compatibility facade re-exports.

### P1: the working tree packages too much work together

The migration plan says:

> Do not rewrite all call sites in one pass.

It also says not to mix endpoint implementation moves with call-site migration.
The current working tree contains both the complete endpoint extraction and the
complete caller migration.

The migration itself is wanted. Do not restore facade imports merely to make the
diff smaller. Instead, split the work into reviewable commits that preserve the
current final state:

1. transport and endpoint module extraction
2. compatibility facade re-exports
3. caller migration by vertical slice
4. server module seam extraction
5. web page and settings module seam extraction
6. test and audit cleanup

## Handoff order

Fix the transport seam first because it carries the largest behavior risk.
Then split browser adapters from fetch-only modules. After that, repair the
proposed-action interface and test fixtures. Finish by dividing the working tree
into reviewable commits.

Run focused tests after each repair. Before handoff or merge, rerun:

```bash
cd web
npm run lint
npm run typecheck
npm test
npm run test:workflow-smoke
npm run build
npm run test:browser
npm run quality
```

## Files to keep out of refactor commits

The working tree also contains unrelated or generated files. Do not include
these in the refactor commits:

- `docs/agents/domain.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/triage-labels.md`
- `.pi/tasks/`

## Review summary

The Standards axis has five findings. The broad mocked-fetch test pattern is the
largest standards problem.

The Spec axis has three findings. Raw transport outside the transport modules is
the most important issue because it bypasses shared authentication and error
handling.

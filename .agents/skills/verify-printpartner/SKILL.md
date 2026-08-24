---
name: verify-printpartner
description: Verify PrintPartner changes through its running API and browser UI. Use after implementing user-visible behavior or when asked for end-to-end proof; use focused tests alone for changes with no observable app behavior.
---

# Verify PrintPartner

Prove the changed behavior through the same boundary a user reaches. Keep every verification run isolated from the developer's data.

## Choose the proof

Identify the shortest user journey that exercises the change and its likely regression boundary. Use one or more of these existing harnesses:

- Focused tests: run the relevant workspace test from `web/`.
- Full repository gate: run `npm run quality` from `web/` when the change is broad or the user requests release-level proof.
- API workflow: run `web/scripts/workflow-smoke.sh` against an isolated running app when the behavior crosses backend workflow stages.
- Browser journey: drive the Vite app at `http://127.0.0.1:5173` with browser automation when the behavior is visible or interactive. Existing browser checks run through `npm run test:browser` from `web/`.

Prefer direct observation of the changed behavior over a broad test suite that only passes nearby code.

## Run an isolated app

1. Create a unique temporary data directory with `mktemp -d` and retain its exact path for cleanup.
2. From `web/`, start the API with `PRINT_PARTNER_DATA_DIR` set to that directory, `HOST=127.0.0.1`, and `PORT=18765`.
3. Start the Vite client from `web/`; its proxy targets `http://127.0.0.1:18765` by default.
4. Wait until `http://127.0.0.1:18765/health` succeeds before driving the UI or workflow script.

Use existing dependencies when present. If dependencies or a Chrome/Chromium executable are missing, report the prerequisite or request authorization for installation when installation is in scope. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can point the existing browser harness at an available executable.

Use only the temporary data directory for writes. Treat an already-running app as developer-owned unless the user explicitly authorizes using it.

## Exercise the journey

Drive the real UI for user-visible changes. Interact through roles, labels, and visible text where possible. Verify the resulting UI state and, when relevant, confirm persisted state after a reload or through the API.

For API workflow proof, set `BASE` to the isolated server URL before running `web/scripts/workflow-smoke.sh`. The script creates sources, builds, plans, progress, and exports, so never aim it at persistent developer or production data.

Capture screenshots for visual claims when browser tooling supports them. Store temporary evidence outside the repository unless the user requests committed artifacts.

## Finish

Stop only the processes started for this verification. Remove the temporary data directory only after checking that its resolved path is the unique directory created for this run.

Report:

- the exact journey exercised;
- the observed result at the user boundary;
- commands or automation used;
- any unverified portion and its concrete blocker.

A passing test without observing the requested user behavior is incomplete when that behavior can be driven locally.

# Gate evidence

> User-visible pull requests must include a screenshot, recording, or verify-skill output/trace in the PR's Evidence section. Gate returns **FAIL** if a user-visible PR lacks this evidence or a non-user-visible PR does not say so.

A change is user-visible when it changes behavior a user can see or reach in
the desk-loop UI (Library → Builds → Sources → Plan → Production ↔ Checkoff)
or an equivalent product surface.

Accepted evidence includes:

- A screenshot showing the changed behavior.
- A recording of the affected journey.
- Verify-skill output or a trace demonstrating the result.

Put evidence in the PR body's **Evidence** section. Attach files or link to
screenshots, recordings, verify output, or trace artifacts. Name the journey
exercised and the result observed so reviewers can assess the change.

Non-user-visible PRs must say so in the Evidence section, with a brief reason.
Gate returns **FAIL** when these requirements are not met.

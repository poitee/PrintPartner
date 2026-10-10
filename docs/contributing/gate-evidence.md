# Gate evidence

> User-visible pull requests must attach or link evidence from the real running app, not mocks or stubs, and include the steps followed to produce it in the PR's Evidence section. Gate returns **FAIL** without this evidence unless one of the four exemptions below applies. Automated verification must never target Chad's LAN instances (.80/.81).

"User-visible" means any change to the UI, routes, printer actions, or the
desktop shell.

Accepted evidence includes:

- A screenshot showing the changed behavior.
- A recording of the affected journey.
- Verify-skill output or a trace demonstrating the result.

Put evidence in the PR body's **Evidence** section. Attach files or link to
screenshots, recordings, verify output, or trace artifacts from the real running
app, not mocks or stubs. Include the steps followed to produce the evidence and
the result observed. Automated verification must never target Chad's LAN
instances (.80/.81).

The only exemptions are exactly these four:

- docs-only
- CI-only
- dependency-only
- internal refactor with no user-visible change

Authors must either attach or link evidence and set `Exemption: none`, or name
one of these four exemptions in the Evidence section and explain why it applies.
Use `Exemption: internal refactor` only when there is no user-visible change.
Gate returns **FAIL** if the evidence or a valid named exemption is missing, or
if automated verification targets Chad's LAN instances (.80/.81).

## Desktop and tray capture

For changes to the desktop app, including Tauri tray menus, windows, and native
UI, attach visual evidence from the real app. On an evidence-enabled Linux
development environment:

1. Run `evidence status` to check the virtual display, tray, and status notifier
   watcher. Build `pp-desktop` in the PR's worktree and run it with `DISPLAY=:99`.
   Follow the [native development setup](../../rust/crates/pp-desktop/README.md)
   to prepare verified runtime resources and isolated temporary data.
2. Capture the window or tray menu with the evidence CLI:

   ```sh
   evidence shot window --window "Print Partner"
   evidence tray-click printpartner
   evidence shot tray --tray
   ```

   `evidence record demo 5` records five seconds of the display. Check that only
   the app is visible before capturing; inspect each artifact before publishing.
3. Publish the selected files:

   ```sh
   evidence publish <pr-number> evidence/window.png evidence/tray.png --note "Desktop window and tray menu after startup"
   ```

   The CLI uploads files to the orphan branch `evidence/<pr-head-branch>` and
   embeds image links in a new PR comment. Copy those links into the PR body's
   **Evidence** section, preserving its existing content. Include the tested
   commit, reproduction steps, and observed result, with `Exemption: none`.

The repository is public. Capture app UI only: never terminals, secrets, logs
with credentials, or other windows. Keep `evidence/` artifacts out of the code
branch. Run one app instance on the evidence display at a time, coordinate with
other users of the display, and stop only the instance you started when finished.

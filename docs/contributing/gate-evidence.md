# Gate evidence

> User-visible pull requests must attach or link evidence from the real running app, not mocks or stubs, and include the steps followed to produce it in the PR's Evidence section. Gate returns **FAIL** without this evidence unless one of the four exemptions below applies. Automated verification must never target Chad's LAN instances (.80/.81).

"User-visible" means any change to the UI, routes, printer actions, or the
desktop shell.

Accepted evidence includes:

- A screenshot showing the changed behavior.
- A recording of the affected journey.
- Verify-skill output or a trace demonstrating the result.

Put evidence in the PR body's **Evidence** section (see
`.github/pull_request_template.md`). Attach files or link to screenshots,
recordings, verify output, or trace artifacts from the real running app, not
mocks or stubs. Include the steps followed to produce the evidence and the
result observed. Automated verification must never target Chad's LAN instances
(.80/.81).

The only exemptions are exactly these four:

- docs-only
- CI-only
- dependency-only
- internal refactor with no user-visible change

Authors must either attach or link evidence and set `Exemption: none`, or name
one of these four exemptions in the Evidence section and explain why it applies
in the **Exemption reason** field. Use `Exemption: internal refactor` only when
there is no user-visible change.

## CI enforcement

The GitHub Actions workflow `.github/workflows/pr-evidence.yml` runs a
lightweight lint on every pull request body:

- Fail when the `## Evidence` section is missing.
- Fail when `Exemption: none` lacks Steps followed (nested bullets are fine),
  Result observed, and a concrete artifact: a URL, a file path such as
  `trace.json`, a Markdown link or image, or inline code holding a command, path,
  or output. A journey name, a bare category word such as `screenshot` (with or
  without backticks), and Exemption reason text do not count.
- Fail when `Exemption:` is still the template placeholder, unknown, or a named
  exemption without a non-empty reason.
- Fail when any verification content (Journey, Steps, Result, artifact, or other
  freeform text in the section) targets Chad's LAN instances
  (`192.168.*.80` / `*.81`). This applies to named exemptions too. Mention those
  hosts only in the Exemption reason.
- HTML comments and fenced code blocks are ignored, so commented-out or example
  Evidence sections do not count. Put real output in a linked file or inline code.

Local check:

```bash
PR_BODY="$(cat body.md)" node scripts/lint-pr-evidence.mjs
node --test scripts/lint-pr-evidence.test.mjs
```

Gate returns **FAIL** if the evidence or a valid named exemption is missing, or
if automated verification targets Chad's LAN instances (.80/.81).

## Desktop and tray capture

For changes to the desktop app, including Tauri tray menus, windows, and native
UI, attach visual evidence from the real app **built at the head SHA** of the PR.
On an evidence-enabled Linux development environment:

1. Run `evidence status` to check the virtual display, tray, and status notifier
   watcher. Build `pp-desktop` at the PR head SHA in its worktree and run it with
   `DISPLAY=:99`.
   Follow the [native development setup](../../rust/crates/pp-desktop/README.md)
   to prepare verified runtime resources and isolated temporary data.
2. Verify the full tray lifecycle and capture the window and tray menu:

   - Close the window: it hides to the tray while the core and Node child stay
     alive. Record their process identities before and after closing.
   - Trigger **Show Print Partner**: it restores the same window. Record the
     window identity before closing and after restoring it.
   - Trigger **Quit Print Partner**: the app exits with status `0`; verify that
     the marker, lease, runtime folder, and socket have been removed.

   `.desktop.lock` stays on disk after Quit. Verify that its exclusive lock has
   been released by re-locking the existing file, then release that check lock;
   file deletion is not the cleanup check.

   On Linux, trigger tray menu items through the app's own `dbusmenu` over D-Bus.
   The PR's **Evidence** section must state that **no literal click was done**
   and identify the menu items triggered this way. The Homelab command
   `evidence tray-click` retains its name; despite that name, do not describe
   these D-Bus menu activations as literal mouse clicks.

   Capture app UI with the evidence CLI during the lifecycle:

   ```sh
   evidence shot window --window "Print Partner"
   evidence tray-click printpartner
   evidence shot tray --tray
   ```

   `evidence record demo 5` records five seconds of the display. Check that only
   the app is visible before capturing; inspect each artifact before publishing.
3. Publish the selected files:

   ```sh
   evidence publish <pr-number> evidence/window.png evidence/tray.png --note "Desktop tray lifecycle built at the head SHA; items triggered through app dbusmenu over D-Bus; no literal click was done"
   ```

   The CLI uploads files to the orphan branch `evidence/<pr-head-branch>` and
   embeds image links in a new PR comment. Copy those links into the PR body's
   **Evidence** section, preserving its existing content. Include the tested
   head SHA, reproduction steps, and observed lifecycle and cleanup results,
   with `Exemption: none`. State that the app was built at the head SHA and that
   no literal click was done for the D-Bus tray menu activations.

The repository is public. Capture app UI only: never terminals, secrets, logs
with credentials, or other windows. Keep `evidence/` artifacts out of the code
branch. Run one app instance on the evidence display at a time, coordinate with
other users of the display, and stop only the instance you started when finished.

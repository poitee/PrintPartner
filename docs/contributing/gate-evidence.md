# Gate evidence

The PR template provides `## Evidence` and `## Exemption` sections.
Put verification output or a description of what you checked under Evidence.
Use `Exemption: none` when providing evidence. If evidence is unavailable,
write a reason directly on the `Exemption:` line; no category is required.

The lint fails only when Evidence is empty or missing and no exemption reason
is given. Whitespace, HTML comments, and unfilled template placeholders
(`<...>`, TODO, TBD, FIXME, or placeholder prompts) count as empty.
An absent or empty `Exemption:` line, `none` (case-insensitive), or an unfilled
placeholder does not provide a reason. Exemption metadata does not itself
count as evidence. The Evidence section ends at the next level-one or
level-two heading; fenced output can be included as evidence.

The lint does not require Steps/Result fields or artifacts and does not check
hosts. Those removed requirements are tracked in
[GRE-583](https://linear.app/greetz/issue/GRE-583).

## CI and local checks

`.github/workflows/pr-evidence.yml` runs the tests and body lint on
`pull_request_target` events, including body edits. It executes the protected
default branch's checker with read-only permissions. This keeps the same
repository evidence policy for stacked PRs whose base branches predate the
checker. The PR body enters the checker through an environment variable;
the workflow never checks out or executes the PR head.

```sh
node --test scripts/lint-pr-evidence.test.mjs
node scripts/lint-pr-evidence.mjs --body-file body.md
```

The checker also accepts `PR_BODY` or `--stdin`.

## Desktop and tray capture

For changes to the desktop app, including Tauri tray menus, windows, and native
UI, attach visual evidence from the real app built at the head SHA of the PR.
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

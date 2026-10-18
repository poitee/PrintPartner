# GRE-695 role picker and preset imports

With the feature gate off, a completed spool save publishes the server's rows
to the original Plan cache and calls `onUpdated`, even after the picker closes
or switches Plans. The new Plan keeps its own cached rows. Gate-on saves retain
their existing Plan and permission checks.

When Spoolman access is denied, preset imports strip Spoolman references.
They skip a role only if stripping those references removes its entire
assignment. An entry that was already all-null remains an explicit clear.
Ordinary catalog colors and custom hex colors still apply.

Gated spool picks show `Saving…` while the request is pending, then `Saved`.
The existing `savingRole` state owns the pending indicator. The duplicate
status write is removed. Plan-denied pickers hide the Settings integration
hint. Gate-off picks retain their existing status and hint behavior.

This change adds no Rust or server code and keeps the existing default-off
feature gates. Focused tests cover delayed saves across unmount and Plan
switch, visible status, denied hints, and preset clears with denied, allowed,
and unspecified access.

Run from `web/` on Node 22:

```sh
npm run test -w @print-partner/web -- src/components/RoleFilamentPicker.features.test.tsx src/lib/colorPresets.test.ts
```

Before the fix, the regressions report `6 failed | 26 passed (32)`.
After the fix, they report `32 passed (32)`. The gated cases include
pending status, permission revocation, and Plan-switch fencing.

The disposable local app also shows `Saving…` while a spool response is held
and `Saved` after release. With a stored Plan Spoolman opt-out, importing an
all-null Accent entry clears its custom color and the clear survives reload.
The Primary spool assignment remains stored, and the denied picker shows no
Settings integration hint. This check uses a local Spoolman fixture and
temporary app data.

Model/harness: Codex gpt-6.1-sol in T3 Code on fleet VM 136.

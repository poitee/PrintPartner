# Farm-filament slot-state TS goldens (GRE-575)

These fixtures record the current, frozen TypeScript behavior in
[`farm-filament.ts`](../../../web/apps/server/src/services/farm-filament.ts),
specifically `slotFilamentStatus` and the empty-slot branch in
`printerFilamentStatus`. They are characterization fixtures, not the desired
Rust behavior. [GRE-488](https://linear.app/greetz/issue/GRE-488) requires an
intentional Rust divergence for unconfigured slots.

Each JSON file contains a `case`, scenario `context`, the actual TS `input`,
and the full printer-level `expected` output (including each slot).
`context.configured` and `context.physically_empty` describe the scenario for
the Rust port; they are **not TS API fields**. TS accepts only a slot number,
label, and nullable color ID, so identical null-ID inputs cannot distinguish
the last two cases below. The label does not determine configuration state.
All cases omit host status to isolate slot inventory from host runout signals.

| Case / file | Scenario / TS input | Current TS slot result | Current TS printer result | Rust requirement |
| --- | --- | --- | --- | --- |
| `loaded-matched.json` | Configured, loaded; Spoolman ID matches two spool summaries | `empty=false`, `low=false`, `remaining_g=790`, `spool_ids=[1,2]` | No swap; total 790 g | **Keep** inventory aggregation and healthy verdict |
| `loaded-no-spoolman-match.json` | Configured, loaded; reachable Spoolman has no matching spools (`[]`) | `empty=false`, `low=true`, `remaining_g=0`, `spool_ids=[]` | Swap; `slot 1 is out of filament`; total 0 g | **Keep** depleted-inventory semantics |
| `blank-filament-color-id.json` | Configured, physically empty; whitespace-only printer-reported ID | ID normalizes to null; `empty=true`, `low=false`, `remaining_g=null` | Swap; `no filament loaded in slot 1`; total null | **Keep** configured blank-ID empty semantics |
| `no-slot-config.json` | Existing PP slot with no filament configured; null ID | `empty=true`, `low=false`, `remaining_g=null` | Swap; `no filament loaded in slot 1`; total null | **Change** to `unconfigured`; no swap and no empty-slot reason |
| `empty-slot.json` | Configured slot, physically empty; null printer-reported ID | `empty=true`, `low=false`, `remaining_g=null` | Swap; `no filament loaded in slot 1`; total null | **Keep** actual empty-slot alert |

“No slot config” here means an existing slot row with no assigned filament,
which exposes the false swap alert targeted by GRE-488. A machine with no slot
rows (`loaded_filaments: []`) already returns `slots: []`, no swap, a null
reason, and a null total in TS; the existing Vitest test covers that behavior,
which Rust must keep.

No matching spools (`[]`) is distinct from an unavailable lookup (`null`), an
untracked catalog/custom ID, or a throwing lookup. Those unknown cases remain
`empty=false`, `low=false`, `remaining_g=null` and must stay unknown in Rust;
the existing unit tests cover them. Null remaining weight must not become 0 g.
The loaded fixture also records trimming of the ID and label.

Run the check from the repository root:

```sh
cd web && npm run test -w @print-partner/server -- src/services/farm-filament.test.ts --reporter=verbose
```

The test reads all JSON files, requires the five case names, and compares the
complete outputs of both TS derivations to the checked-in goldens. It does not
rewrite fixtures. Any future update must preserve the distinction between
recorded TS behavior and the Rust changes required by GRE-488. No live printer,
Spoolman endpoint, or Rust crate is used by this check.

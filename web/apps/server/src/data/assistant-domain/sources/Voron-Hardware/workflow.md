# Voron-Hardware — Print Partner workflow
1. Add `Voron-Hardware`; **Sync**. Only ref: `master` (no tags).
2. Attach as **addon**, scoped to ONE project subdirectory (e.g. Stealthburner_Toolhead_PCB) — never the whole repo.
3. Manifest: include only that project's STL(s); PCB gerbers are not print parts.
4. **Sync after changing ref**; recompute when switching wiring strategy (umbilical vs CAN).

# Voron-0 — Print Partner workflow
1. Add `Voron-0`; **Sync**. Default ref is branch `Voron0.2r1` — there is no V0.2 tag; do not pick tag `V0.1` for a 0.2 build.
2. Attach as **base**. Toolhead (Mini SB) is already inside this repo.
3. LDO kit: attach `LDOVoron0` at branch `v02r1` as addon (+ `LDO-Picobilical` if the kit includes the umbilical).
4. Manifest selections: display yes/no, tophat panels, multibody vs single-body alternates, electronics mounts (SKR Pico / Pi variants).
5. **Sync after changing branch/tag** (v01 / v02 / v02r1 branches on the LDO side).
6. Recompute after toggling Picobilical (swaps toolhead strain-relief parts).

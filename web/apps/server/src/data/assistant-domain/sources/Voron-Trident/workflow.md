# Voron-Trident — Print Partner workflow
1. Add source `Voron-Trident` (https://github.com/VoronDesign/Voron-Trident) and **Sync**.
2. Pick ref: tag `VTr2` for the released R2 kit (what LDO Trident kits ship against), or branch `main` for latest fixes. **User must Sync again after changing tag.**
3. Attach as **base**.
4. Attach addons: `Voron-Stealthburner` (required toolhead), `LDOVoronTrident` (if LDO kit), optional probe (`Voron-Tap` OR `Klicky-Probe`), optional `Galileo2` extruder.
5. Kit-manifest selections to expect: skirt size (250/300/350), z 2hole vs 3hole (must match SB chain anchor), rear skirt power inlet variant, controller mount, front doors.
6. Exclude `STLs/superseded_parts/**` and `STLs/Tools/**` (jigs) from part counts unless requested.
7. Recompute the manifest after: tag change, adding/removing probe addon, switching 2hole/3hole.

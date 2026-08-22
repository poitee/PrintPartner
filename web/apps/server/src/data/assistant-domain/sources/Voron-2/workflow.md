# Voron-2 — Print Partner workflow
1. Add source `Voron-2` and **Sync**. Default branch is `Voron2.4` (not main/master).
2. Pick ref: tag `V2.4r2` for the pinned release; branch `Voron2.4` for latest. Do NOT pick `V2.4r1` or earlier for a new build — the STL tree is nested differently (STLs/VORON2.4/...). **Sync after changing tag.**
3. Attach as **base**; addons: `Voron-Stealthburner`, `LDOVoron2` (LDO kit), probe (`Voron-Tap` OR `Klicky-Probe`), optional `Galileo2` (G2E and/or G2Z).
4. Manifest selections: skirt size 250/300/350, panel clip 4mm vs 6mm, power inlet variant, controller/PSU mounts, exhaust filter yes/no.
5. Exclude `STLs/Superceded_Parts/**`, `STLs/Test_Prints/**`, `STLs/Tools/**` from required counts.
6. Recompute after tag change or probe/extruder addon swap.

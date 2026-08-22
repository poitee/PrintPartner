# Voron-Trident — pitfalls
- Wrong tag: `Trident` and `Trident-prerelease` are old refs; R2 is tag `VTr2`, not "R2" (no tag literally named R2).
- VTr1 selections don't map to VTr2/main: STL top-level folders were renamed (ElectronicsBay -> electronics_bay, Exhaust_Filter removed to superseded).
- Panel clips differ between VTr2 and main (4mm variants superseded on main) — recompute after switching.
- Confusing LDOVoronTrident for a fork: it only contains ~4 LDO-specific replacement parts, not the printer.
- Looking for the toolhead here: SB printheads are in Voron-Stealthburner; but the X carriage is in this repo (STLs/Gantry/X_Axis).
- Forgetting to Sync after changing tag — manifest will still show the old file set.

# LDOVoronTrident — pitfalls
- Wrong branch name: default is `master` here but `main` on LDOVoron2 — don't assume.
- README references upstream file `power_inlet_adamstech.stl` (STLs/Skirt/...); on current Trident main the equivalent is rear_skirt_power_adamstech.stl — verify by tag before flagging missing files.
- Keeping both stock and LDO variants of the power inlet / deck wire cover in one manifest.
- Expecting the printer STLs here — supplement only (~4 parts + mounts).

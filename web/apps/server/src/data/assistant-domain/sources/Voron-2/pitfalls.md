# Voron-2 — pitfalls
- Assuming default branch is `main` — it is `Voron2.4`.
- Using V2.4r1-era paths (STLs/VORON2.4/Electronics_Compartment/Plug_Panel/...) against the current tree; LDOVoron2's own STLs/README.md still links those old paths.
- Spelling: the folder really is `Superceded_Parts` (sic) — don't "fix" it to Superseded.
- Keeping both nozzle_probe.stl and a Tap/Klicky addon in one manifest.
- Counting Test_Prints (Voron_Design_Cube_v7.stl etc.) as kit parts.
- Forgetting Sync after switching V2.4r2 <-> Voron2.4 branch.

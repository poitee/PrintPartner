# Micron — Print Partner workflow
1. Add `Micron`; **Sync**. Prefer branch `main` pinned by commit; tag `latest` is floating — warn users.
2. Attach as **base**; select SIZE first (120 vs 180) — this filters filenames, not folders.
3. LDO Micron kit: also select STLs/Kit_Specific_Parts/LDO. West3D Micron+: attach `West3D-Micron` addon and use 180 files.
4. Selections: bowden entry (ECAS/M10, MMU), klicky dock (if Klicky attached), controller/PSU mounts, panel clip foam thickness.
5. Exclude Mods/ and Tools/ by default. **Sync after changing tag** and recompute after size switch.

# Galileo2 — pitfalls
- Attaching all three subprojects at once (G2SA vs G2E are alternative extruders).
- Case-sensitive paths: galileo2_standalone/STL vs galileo2_extruder/stl.
- Filenames with embedded spaces ('corner_left x2.stl') break naive slug parsing.
- Keeping SB Clockwork2 parts selected alongside G2E.
- Assuming a release tag exists — status is tracked in README text only.

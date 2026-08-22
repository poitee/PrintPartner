# Global pitfalls (cross-repo)
- Default refs are irregular: Voron-2=Voron2.4, Voron-0=Voron0.2r1, LDOVoron0=v02r1, LDOVoronSW=s1, LDOVoronTrident=master, LDOVoron2=main. Never assume main/master.
- Release identity is inconsistent: tags (VTr2, V2.4r2, V1.0), branches (Voron0.2r1, v02r1, s1), filename suffixes (_r8 in Tap), folders (Boop beta_4), floating tag (Micron `latest`).
- STL root spelling varies: STLs/ (most), STL/ (Switchwire), stl/ vs STL/ (Galileo2 subprojects), stl/ (pancake board), none (Voron-Hardware, Klicky, Boop, chirpy).
- LDO repos are kit SUPPLEMENTS to VoronDesign upstream, never forks/mirrors — a stack always needs the upstream base too.
- After ANY tag/branch change the user must Sync before recomputing the manifest.
- Never invent ids: Tap has no "R8" tag; Trident has no "R2" tag (it's VTr2); Boop has no beta_2.

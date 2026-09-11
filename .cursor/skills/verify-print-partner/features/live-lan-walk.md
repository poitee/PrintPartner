# Live LAN walk (human / Mac)

This is a **separate evidence path** for a human on the Mac desk loop. Cloud
agents **cannot** reach `192.168.200.80:8080`. Do not pretend a cloud run verified
this checklist. Use Docker verification (`SKILL.md` Launch) for agent proof.

## Sub-features

- `lan-rebuild` rebuilds/restarts Print Partner Docker on the Mac host.
- `lan-walk-stages` walks Sources → Plan → Checkoff on the live desk UI.
- `lan-prusa-core-one` opens newest files on Prusa Core One 0 without changing print counts.
- `lan-open-print` opens a real print for inspection without mutating checkoff counts.

## How to get to it (user POV)

- On the Mac that publishes the desk loop, open `http://192.168.200.80:8080`
  (or the host's LAN URL from README).
- Use the same spine/stage navigation as cloud Docker: Source Library, Builds,
  Sources, Plan, Production, Checkoff.

## Driving it with control-print-partner

Preconditions:

- **Human on LAN Mac only.** Cloud agents must skip and record
  `blocked: LAN 192.168.200.80 unreachable from cloud VM`.
- Live data is developer-owned — prefer read-only observation; do not run
  `workflow-smoke.sh` against it.

Checklist (manual; capture screenshots on the Mac if evidence is needed):

1. **Rebuild Docker on Mac.** From the PrintPartner checkout:
   `docker compose up --build -d` (or pull the release tag you intend to walk).
   Confirm `curl -s http://127.0.0.1:8080/health` (or the LAN URL) returns ok.
2. **Sources.** Open Source Library; open the active Build's Sources stage.
3. **Plan.** Open Plan; confirm files, quantities, and colors for the working kit
   without accepting unless that is an intentional live change.
4. **Checkoff.** Open Checkoff for the Accepted Plan; observe required units.
5. **Prusa Core One 0 — newest files.** On the printer / PrusaLink UI for
   Core One 0, browse the newest files list. **Do not change print counts** in
   Print Partner while inspecting.
6. **Open a real print.** Open one real print job/file for inspection.
   **Do not adjust Print Partner print/checkoff counts** as part of this walk
   unless a separate, intentional live change was requested.

Record: rebuild command output, stage screenshots, printer file list screenshot,
and an explicit note that print counts were left unchanged.

## Gotchas

- Cloud Docker on `127.0.0.1:8080` is **not** a substitute for this LAN walk.
- Touching live checkoff counts or accepting Plans on LAN data is out of scope
  for a default verification walk.
- If the LAN bind changed (`PP_BIND_ADDRESS`), use the Mac's current published URL
  from README / `.env` instead of assuming `192.168.200.80`.

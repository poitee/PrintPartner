# Live production observation

You observe the current production desk loop from a client computer. Production runs on apps VM 111. Open `http://192.168.200.81:8080`. The print-partner MCP endpoint is `http://192.168.200.81:8080/api/v1/mcp`. Cloud agents cannot reach `192.168.200.80:8080` or `192.168.200.81:8080`. Do not report a cloud run as this checklist. Agent proof uses the isolated Docker launch in `SKILL.md`.

## Sub-features

- `lan-walk-stages` observes Sources, Plan, and Checkoff on the production UI.
- `lan-prusa-core-one` opens the newest files on Prusa Core One 0 without changing print counts.
- `lan-open-print` opens a real print for inspection without changing checkoff counts.

## How to get to it (user POV)

- On a computer that can reach the LAN, open `http://192.168.200.81:8080`.
- That computer only displays the UI. Apps VM 111 is the server.
- `http://192.168.200.80:8080` is a temporary forwarder for the rollback copy. GRE-460 retires that copy no earlier than 2026-10-18. Do not use `.80` as the current production target.
- Move through the same stages as isolated Docker: Source Library, Builds, Sources, Plan, Production, Checkoff.

## Driving it with control-print-partner

Preconditions:

- **You are on a LAN client.** Cloud agents skip this walk and record `blocked: LAN 192.168.200.80/.81 unreachable from cloud VM`.
- Observe Sources, Plan, Checkoff, and real print or file records. Do not change print counts. Do not accept a Plan.
- Do not rebuild, restart, pull, or compose the live apps VM for this walk. Deployment needs a separate authorization.
- Do not run `workflow-smoke.sh` against production.

Checklist. Capture screenshots on the client computer when you need evidence.

1. **Open production.** Open `http://192.168.200.81:8080`. Confirm the desk loop loads. Do not rebuild or restart the VM.
2. **Sources.** Open Source Library. Open the active Build's Sources stage.
3. **Plan.** Open Plan. Confirm files, quantities, and colors. Do not accept a Plan.
4. **Checkoff.** Open Checkoff for the Accepted Plan. Observe the required units. Do not change print counts.
5. **Prusa Core One 0, newest files.** On the printer or PrusaLink UI for Core One 0, browse the newest files. Do not change print counts in Print Partner.
6. **Open a real print.** Open one real print job or file. Do not adjust print or checkoff counts.

Record the stage screenshots, the printer file list screenshot, and a note that print counts and Plan acceptance stayed unchanged.

## Gotchas

- Isolated Docker on `127.0.0.1:8080` proves a development copy. It does not prove this production observation.
- Changing live checkoff counts or accepting a Plan on production data is outside this walk.
- If `PP_BIND_ADDRESS` changed, use the published production URL. Do not assume `192.168.200.80` or `192.168.200.81`. The current published UI is `http://192.168.200.81:8080`.

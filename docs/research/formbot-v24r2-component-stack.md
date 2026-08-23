# Formbot Voron 2.4r2 350 component stack

Research date: 2026-08-23

This note evaluates the requested Stealthburner, Galileo 2 Extruder (G2E), Rapido 2 Fiber UHF, Beacon H USB, EBB36 USB, USB umbilical, and BTT Octopus stack. It uses only upstream project and manufacturer sources. Purchased hardware is a compatibility constraint; only its required mounts, anchors, covers, and toolhead parts belong in the printable Build.

## Recommended source layers

| Requested item | Build treatment | Printable effect | Decision still required |
| --- | --- | --- | --- |
| Voron Stealthburner | Add the official Stealthburner repository as the toolhead source. | Supplies the cooling assembly and hotend-specific printhead parts. It replaces the base repository's toolhead selection, not the V2.4 frame. | Select the hotend mount described below. |
| Galileo 2 Extruder | Add the official Galileo2 repository as an extruder mod. | Replace the Clockwork 2 extruder prints with the G2E print set. | Choose friction-fit or ECAS front body. Do not select a cable-chain anchor for an umbilical unless it is intentionally retained. |
| Rapido 2 Fiber UHF | Record the hotend as hardware and add an explicit UHF mount source. | Replace the standard Rapido front/rear printhead with a UHF-specific pair. | Confirm that “Fiber UHF” means the Phaetus Rapido 2 Plus UHF model and choose the exact mount source/version. |
| Beacon H USB | Record Beacon as the probe and its mount source as a mod. | Replace the stock probe mount with a Beacon-compatible mount; exact printable files cannot be inferred from Beacon's documentation alone. | Choose a mount proven for the selected Stealthburner + Rapido UHF geometry and confirm the bed stack. |
| BTT EBB36 USB | Record the exact EBB36 revision and USB mode as hardware constraints; add a separate mount/strain-relief source. | Adds or replaces the rear toolhead-board mount, cover, and umbilical strain relief. | Confirm EBB36 v1.x versus EBB36 Gen2 and select a G2E-compatible mount. |
| USB umbilical | Treat as a transport choice spanning Beacon, EBB36, toolhead anchors, and frame anchors. | Replaces X-chain/cable-chain attachment parts with compatible toolhead and frame anchors. | Decide whether Beacon has its own USB cable or shares the EBB36 Gen2 passthrough; choose routing and strain-relief design. |
| BTT Octopus | Keep as the main-controller compatibility constraint. | No printable change unless the Formbot electronics mounts do not match the exact Octopus revision. | Confirm Octopus model/revision and available host USB ports. |

## Compatibility findings

### Stealthburner and G2E

Voron describes Stealthburner as a modular system with interchangeable extruder, hotend toolhead, and cooling assembly. This makes the G2E and hotend mount separate selections rather than one monolithic variant ([Voron hardware guide](https://github.com/VoronDesign/Voron-Documentation/blob/main/hardware.md#stealthburner)).

G2E is explicitly a drop-in Stealthburner extruder replacement. Its upstream printable set calls for one of each common STL, with accent parts marked `[a]`. It also requires exactly one front-body option (friction-fit PTFE or ECAS coupler) and, for a conventional chain, exactly one two-hole or three-hole chain part ([G2E overview](https://github.com/JaredC01/Galileo2/blob/main/galileo2_extruder/README.md), [G2E STL selection](https://github.com/JaredC01/Galileo2/blob/main/galileo2_extruder/stl/README.md)).

For this Build, G2E should replace Clockwork 2 rather than be included alongside it. The requested umbilical also means the chain option is not automatically applicable: a chosen EBB36/umbilical mount may replace the G2E cable cover and chain-anchor parts. That overlap must be resolved after selecting the mount source.

G2E also changes runtime configuration. Upstream specifies `rotation_distance: 47.088`, `gear_ratio: 9:1`, `microsteps: 16`, and a TMC2209 starting current of `0.6` A, followed by normal extruder calibration ([Galileo2 README](https://github.com/JaredC01/Galileo2#klipper-settings-for-g2-extruders-g2e-and-g2sa)). These are verification notes, not printable parts.

### Rapido 2 Fiber UHF

The official Stealthburner compatibility table says its generic Phaetus Rapido selection supports only standard Rapido, not UHF ([Stealthburner printhead table](https://github.com/VoronDesign/Voron-Stealthburner/blob/main/STLs/Stealthburner/Printheads/README.md)). The repository now includes a Rapido V2 mount and assembly guidance, but its README calls that mount “High Flow”; it does not establish UHF compatibility ([Rapido V2 mount instructions](https://github.com/VoronDesign/Voron-Stealthburner/blob/main/STLs/Stealthburner/Printheads/phaetus_rapido_v2/README.md)). Therefore the stock/generic Stealthburner Rapido files must not be silently selected for the requested UHF hotend.

Phaetus publishes a first-party `voron 2.4-Rapido 2.zip` adapter package containing distinct HF and UHF front files plus rear files ([Phaetus Rapido 2 Plus repository](https://github.com/Phaetus/Rapido-2-Plus/tree/main/Product%20Adaptor%20Models)). That is the strongest upstream candidate for the UHF printable pair. Before including it, confirm the requested product is the Rapido 2 Plus UHF and inspect the adapter's fit with the selected G2E/Stealthburner revision. The Phaetus repository labels shared models as personal-use-only, so the Build should preserve this provenance and license note ([Phaetus repository README](https://github.com/Phaetus/Rapido-2-Plus)).

### Beacon H USB

Beacon H is a USB probe intended for Klipper/Kalico. The manufacturer calls the normal form factor suitable for Stealthburner printers, requires a conductive bed surface/substrate at least 400 um thick, and warns that oversized fixed magnets may not work ([Beacon H product page](https://www.beacon3d.com/product/beacon-h/)). The Formbot bed stack therefore needs explicit verification; “Voron 2.4-compatible” alone is insufficient.

Beacon's quick start requires mounting the sensor nominally 2.6 mm recessed from the nozzle, respecting its metal keep-out, and notes that a custom mount may be necessary. Its included cable should be routed along the filament path or umbilical and is not recommended for continuous flexing in a cable chain ([Beacon quick start](https://docs.beacon3d.com/quickstart/)). Beacon's installation page links an unofficial Annex Stealthburner carriage for V2.4/Trident, but the mount's own upstream notes say it was modeled and confirmed with Revo and that other hotends may vary ([Beacon installation choices](https://docs.beacon3d.com/installation/), [Annex Stealthburner Beacon carriage](https://github.com/Annex-Engineering/Annex-Engineering_User_Mods/tree/main/Printers/Non_Annex_Printers/VORON_Printers/VORON_V2dot4/annex_dev-stealthburner_beacon_x_carriage)). It is therefore only a candidate: Rapido UHF clearance still needs verification.

Beacon replaces a conventional Klipper `[probe]` configuration and can provide the Z virtual endstop. The upstream setup sets `homing_retract_dist: 0`; RevH also exposes an accelerometer ([Beacon quick start](https://docs.beacon3d.com/quickstart/)). These are compatibility and setup requirements rather than parts.

### EBB36 in USB mode

The requested board revision materially changes the wiring plan:

- EBB36 v1.0/v1.1/v1.2 supports USB communication and separately powered 24 V operation. Its VUSB jumper is for USB power or back-power use, not a substitute for checking the board's 24 V wiring and exact revision. The v1.1 documentation also warns that entering DFU with the hotend powered can drive the heater output, so heater power must be disconnected or the update completed promptly ([BTT EBB36 documentation](https://github.com/bigtreetech/docs/blob/master/docs/EBB%2036%20CAN.md)).
- EBB36 Gen2 uses no communication-mode jumper for USB, requires BTT's adapter board for both USB and CAN, requires separate 24 V power, and says not to connect USB and CAN simultaneously. In USB mode its provided shielded cable/adapter path is required; the passthrough becomes USB ([BTT EBB36 Gen2 documentation](https://github.com/bigtreetech/docs/blob/master/docs/EBB36_GEN2.md)).

Neither BTT source supplies a G2E/Stealthburner printable mount. G2E's upstream STL set likewise contains no EBB36-specific mount. Consequently, “EBB36 USB” cannot yet produce a verified printable selection: the user must confirm the board revision and choose a compatible rear mount, cover, and strain-relief source. That source should explicitly cover G2E, because G2E replaces the Clockwork 2 rear-body geometry used by many EBB36 mounts.

### USB umbilical and Octopus

An EBB36 USB umbilical still carries separate toolhead power; USB is the communication link, not the heater/fan power supply. Beacon also needs USB to the single-board computer. With a legacy EBB36 this normally implies two USB data paths at the moving toolhead. EBB36 Gen2 can expose a USB passthrough, but using it is a board-specific architecture decision, not something to infer from the phrase “USB umbilical” ([BTT EBB36 Gen2 documentation](https://github.com/bigtreetech/docs/blob/master/docs/EBB36_GEN2.md), [Beacon quick start](https://docs.beacon3d.com/quickstart/)). Beacon cable revision is also a safety constraint: its normal and low-profile cables are not interchangeable, and the RevH page identifies the required cable by form factor ([Beacon USB cable guide](https://docs.beacon3d.com/usb_cables/), [Beacon RevH guide](https://docs.beacon3d.com/revh/)).

The Octopus has eight motor-driver sockets and native USB-C host communication, so it is suitable as the V2.4 main motion controller. It does not remove the need for a single-board computer USB connection to Beacon/EBB36. BTT documents 24 V as the recommended input and warns that Octopus variants/revisions have distinct pinouts and jumper details ([BTT Octopus documentation](https://github.com/bigtreetech/docs/blob/master/docs/Octopus.md)). The Build should therefore record the exact Octopus revision and Formbot electronics mounting source, but should not invent new printable parts unless that physical comparison finds a mismatch.

## Decisions to ask the user, in order

1. Is the hotend exactly **Phaetus Rapido 2 Plus UHF**, and does “Fiber” describe a separate product variant or seller label?
2. Is the toolboard **EBB36 v1.x** or **EBB36 Gen2**?
3. Should Beacon use its own direct USB run, or—only for Gen2—the EBB36 USB passthrough?
4. Which first-party or user-approved repository supplies the G2E-compatible EBB36 mount and USB-umbilical anchors?
5. Which Beacon mount is approved for the selected Stealthburner/Rapido UHF/toolboard geometry?
6. Does the G2E use the friction-fit PTFE front body or the ECAS-coupler front body?
7. What exact Octopus model/revision and conductive Formbot bed stack are present?

Until these choices are answered, the planning state should mark Rapido UHF mounting, Beacon mounting/bed compatibility, EBB36 mounting, and USB routing as `unverified`. It can safely include Stealthburner and the common G2E parts, but it should not rebuild or apply the final printable draft.

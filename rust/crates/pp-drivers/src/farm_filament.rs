//! Farm filament slot-state and swap-verdict derivations (Rust port of the
//! frozen TypeScript `farm-filament.ts`).
//!
//! GRE-488 splits the TypeScript `empty` slot state into two explicit states:
//! [`SlotState::Unconfigured`] — a slot PP has not assigned a filament to, which
//! must raise no swap alert — and [`SlotState::Empty`] — a configured slot whose
//! printer reports a blank id, which remains a real swap trigger.
//! [`SlotState::Unknown`] stays for inventory that cannot be read (Spoolman
//! unreachable, or a non-Spoolman id), which is deliberately not a swap trigger
//! either.

use pp_api_types::printer_status::PrinterHostStatus;

/// Grams below which a slot's filament triggers a swap recommendation.
pub const LOW_FILAMENT_THRESHOLD_G: f64 = 150.0;

/// One Spoolman spool summary backing a filament colour id.
#[derive(Clone, Debug, PartialEq)]
pub struct SpoolSummary {
    pub spool_id: u64,
    pub remaining_g: f64,
}

/// A printer slot as known to PP: the PP-side configuration plus the
/// printer-reported filament id.
#[derive(Clone, Debug, PartialEq)]
pub struct FilamentSlot {
    pub slot: u32,
    /// Whether PP has a filament configured for this slot. GRE-488 uses this to
    /// tell `unconfigured` apart from `empty`.
    pub configured: bool,
    /// Printer-reported colour id; blank/whitespace normalizes to `None`.
    pub filament_color_id: Option<String>,
    pub label: String,
}

/// The three explicit slot states GRE-488 requires, plus the tracked case.
#[derive(Clone, Debug, PartialEq)]
pub enum SlotState {
    /// No filament configured in PP. No swap alert.
    Unconfigured,
    /// Configured, but the printer reports a blank id. Swap alert.
    Empty,
    /// Inventory unavailable (Spoolman unreachable, or untracked id). No opinion.
    Unknown,
    /// Tracked against Spoolman inventory.
    Loaded {
        remaining_g: f64,
        spool_ids: Vec<u64>,
        low: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct SlotFilamentStatus {
    pub slot: u32,
    pub label: String,
    pub filament_color_id: Option<String>,
    pub state: SlotState,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Machine {
    pub loaded_filaments: Vec<FilamentSlot>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrinterFilamentStatus {
    pub slots: Vec<SlotFilamentStatus>,
    pub needs_filament_swap: bool,
    pub filament_swap_reason: Option<String>,
    /// Sum over tracked (loaded) slots; `None` when none are tracked.
    pub filament_remaining_g: Option<f64>,
}

/// Resolves a filament colour id to the spools backing it.
///
/// `None` means "no inventory record for this filament" (not Spoolman-backed, or
/// Spoolman unreachable), reported as [`SlotState::Unknown`]. `Some(vec![])`
/// means Spoolman knows the filament and every spool is depleted, which IS a
/// swap trigger ([`SlotState::Loaded`] with `low`).
pub type SpoolLookup<'a> = dyn Fn(&str) -> Option<Vec<SpoolSummary>> + 'a;

/// Grams remaining for one slot, given a spool lookup for its filament id.
pub fn slot_filament_status(slot: &FilamentSlot, lookup: &SpoolLookup<'_>) -> SlotFilamentStatus {
    let label = slot.label.trim().to_owned();

    // GRE-488: a slot with no PP configuration is `unconfigured`, never `empty`,
    // regardless of what the printer reports.
    if !slot.configured {
        return SlotFilamentStatus {
            slot: slot.slot,
            label,
            filament_color_id: None,
            state: SlotState::Unconfigured,
        };
    }

    // Configured, but the printer reports a blank id: physically empty.
    let Some(color_id) = slot
        .filament_color_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return SlotFilamentStatus {
            slot: slot.slot,
            label,
            filament_color_id: None,
            state: SlotState::Empty,
        };
    };

    match lookup(color_id) {
        // No inventory record: Spoolman unreachable, or a catalog/custom id that
        // is a colour choice rather than an inventory record. Unknown, never 0 g.
        None => SlotFilamentStatus {
            slot: slot.slot,
            label,
            filament_color_id: Some(color_id.to_owned()),
            state: SlotState::Unknown,
        },
        Some(spools) => {
            let remaining: f64 = spools.iter().map(|spool| spool.remaining_g).sum();
            SlotFilamentStatus {
                slot: slot.slot,
                label,
                filament_color_id: Some(color_id.to_owned()),
                state: SlotState::Loaded {
                    remaining_g: remaining.round(),
                    spool_ids: spools.iter().map(|spool| spool.spool_id).collect(),
                    low: remaining <= LOW_FILAMENT_THRESHOLD_G,
                },
            }
        }
    }
}

/// Does the live host status message say the printer is out of filament?
///
/// Mirrors the frozen TypeScript `RUNOUT_PATTERN`:
/// `\b(runout|run out|run-out|filament\s*(out|empty|error|jam)|out of filament|load filament|insert filament|filament\s*sensor)\b/i`.
/// Dependency-free: the ASCII word-boundary checks below reproduce the TS `\b`
/// anchors, and the alternation reduces to fixed literals plus `filament`,
/// optional whitespace, and a qualifier. Whitespace is not collapsed, because
/// the literal `run out` alternative requires its one plain space.
pub fn host_reports_filament_runout(status: Option<&PrinterHostStatus>) -> bool {
    let Some(message) = status.and_then(|status| status.message.as_deref()) else {
        return false;
    };
    let message = message.trim();
    if message.is_empty() {
        return false;
    }
    let message = message.to_lowercase();
    const LITERALS: [&str; 6] = [
        "runout",
        "run out",
        "run-out",
        "out of filament",
        "load filament",
        "insert filament",
    ];
    const FILAMENT_QUALIFIERS: [&str; 5] = ["out", "empty", "error", "jam", "sensor"];

    LITERALS
        .iter()
        .any(|literal| contains_word_bounded(&message, literal))
        || contains_filament_qualifier(&message, &FILAMENT_QUALIFIERS)
}

/// ASCII word byte, matching the TS regex `\b` definition (`[A-Za-z0-9_]`).
fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Whether `index` sits on a `\b` boundary in `bytes` (exactly one side is a
/// word byte).
fn is_word_boundary(bytes: &[u8], index: usize) -> bool {
    let before = index.checked_sub(1).is_some_and(|i| is_word_byte(bytes[i]));
    let after = bytes.get(index).is_some_and(|&byte| is_word_byte(byte));
    before != after
}

fn contains_word_bounded(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut search_from = 0;
    while let Some(offset) = haystack[search_from..].find(needle) {
        let start = search_from + offset;
        if is_word_boundary(bytes, start) && is_word_boundary(bytes, start + needle.len()) {
            return true;
        }
        search_from = start + 1;
    }
    false
}

/// The TS regex `\s` character class, which differs slightly from
/// [`char::is_whitespace`] (it includes the BOM and excludes U+0085).
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `filament\s*(out|empty|error|jam|sensor)` with both `\b` anchors.
fn contains_filament_qualifier(haystack: &str, qualifiers: &[&str]) -> bool {
    const NEEDLE: &str = "filament";
    let bytes = haystack.as_bytes();
    let mut search_from = 0;
    while let Some(offset) = haystack[search_from..].find(NEEDLE) {
        let start = search_from + offset;
        let after_needle = start + NEEDLE.len();
        if is_word_boundary(bytes, start) {
            let rest = &haystack[after_needle..];
            let qualifier_start = after_needle
                + rest
                    .find(|character: char| !is_js_whitespace(character))
                    .unwrap_or(rest.len());
            let rest = &haystack[qualifier_start..];
            if qualifiers.iter().any(|qualifier| {
                rest.starts_with(qualifier)
                    && is_word_boundary(bytes, qualifier_start + qualifier.len())
            }) {
                return true;
            }
        }
        search_from = start + 1;
    }
    false
}

/// Combine slot inventory with the live host status into a single swap verdict.
/// Precedence: an explicit host runout beats inventory, an empty slot beats a
/// low slot, and a low slot beats nothing. Unconfigured slots are never a swap
/// trigger.
pub fn printer_filament_status(
    machine: &Machine,
    lookup: &SpoolLookup<'_>,
    host_status: Option<&PrinterHostStatus>,
) -> PrinterFilamentStatus {
    let slots: Vec<SlotFilamentStatus> = machine
        .loaded_filaments
        .iter()
        .map(|slot| slot_filament_status(slot, lookup))
        .collect();

    let filament_remaining_g = slots
        .iter()
        .filter_map(|slot| match slot.state {
            SlotState::Loaded { remaining_g, .. } => Some(remaining_g),
            _ => None,
        })
        .reduce(|sum, grams| sum + grams);

    if host_reports_filament_runout(host_status) {
        let reason = match host_status.and_then(|status| status.message.as_deref()) {
            Some(message) if !message.is_empty() => {
                format!("printer reports filament runout: {}", message.trim())
            }
            _ => "printer reports filament runout".to_owned(),
        };
        return PrinterFilamentStatus {
            slots,
            needs_filament_swap: true,
            filament_swap_reason: Some(reason),
            filament_remaining_g,
        };
    }

    let empty_slots: Vec<u32> = slots
        .iter()
        .filter(|slot| matches!(slot.state, SlotState::Empty))
        .map(|slot| slot.slot)
        .collect();
    if !empty_slots.is_empty() {
        let named = empty_slots
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        return PrinterFilamentStatus {
            slots,
            needs_filament_swap: true,
            filament_swap_reason: Some(format!("no filament loaded in slot {named}")),
            filament_remaining_g,
        };
    }

    let low_slots: Vec<(u32, f64)> = slots
        .iter()
        .filter_map(|slot| match slot.state {
            SlotState::Loaded {
                remaining_g,
                low: true,
                ..
            } => Some((slot.slot, remaining_g)),
            _ => None,
        })
        .collect();
    if !low_slots.is_empty() {
        let reason = low_slots
            .iter()
            .map(|(slot, grams)| {
                if *grams == 0.0 {
                    format!("slot {slot} is out of filament")
                } else {
                    format!("slot {slot} is low (~{grams} g left)")
                }
            })
            .collect::<Vec<_>>()
            .join("; ");
        return PrinterFilamentStatus {
            slots,
            needs_filament_swap: true,
            filament_swap_reason: Some(reason),
            filament_remaining_g,
        };
    }

    PrinterFilamentStatus {
        slots,
        needs_filament_swap: false,
        filament_swap_reason: None,
        filament_remaining_g,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pp_api_types::printer_status::PrinterHostState;

    const SPOOLMAN: &str = "spoolman:workshop:filament:";

    fn spool(id: u64, grams: f64) -> SpoolSummary {
        SpoolSummary {
            spool_id: id,
            remaining_g: grams,
        }
    }

    fn slot(n: u32, configured: bool, color_id: Option<&str>, label: &str) -> FilamentSlot {
        FilamentSlot {
            slot: n,
            configured,
            filament_color_id: color_id.map(str::to_owned),
            label: label.to_owned(),
        }
    }

    fn machine(slots: Vec<FilamentSlot>) -> Machine {
        Machine {
            loaded_filaments: slots,
        }
    }

    /// Lookup over a fixed filament-id -> spools table; ids outside the table are
    /// "not tracked" (`None`).
    fn spoolman_lookup(
        table: &[(u64, Vec<SpoolSummary>)],
    ) -> impl Fn(&str) -> Option<Vec<SpoolSummary>> + '_ {
        move |color_id: &str| {
            let id = color_id.strip_prefix(SPOOLMAN)?.parse::<u64>().ok()?;
            table
                .iter()
                .find(|(key, _)| *key == id)
                .map(|(_, spools)| spools.clone())
        }
    }

    #[test]
    fn no_filament_configured_reports_unconfigured_and_no_swap() {
        let slots = vec![slot(1, false, None, "")];
        let lookup = spoolman_lookup(&[]);
        let status = printer_filament_status(&machine(slots), &lookup, None);

        assert_eq!(status.slots[0].state, SlotState::Unconfigured);
        assert_eq!(status.slots[0].filament_color_id, None);
        assert!(!status.needs_filament_swap);
        assert_eq!(status.filament_swap_reason, None);
        assert_eq!(status.filament_remaining_g, None);
    }

    #[test]
    fn blank_reported_id_after_configuration_reports_empty_and_swap() {
        for blank in [None, Some(" \t\n ")] {
            let slots = vec![slot(1, true, blank, "")];
            let lookup = spoolman_lookup(&[]);
            let status = printer_filament_status(&machine(slots), &lookup, None);

            assert_eq!(status.slots[0].state, SlotState::Empty);
            assert!(status.needs_filament_swap);
            assert_eq!(
                status.filament_swap_reason.as_deref(),
                Some("no filament loaded in slot 1")
            );
        }
    }

    #[test]
    fn unreachable_spoolman_reports_unknown_and_no_swap() {
        let unavailable = |_: &str| None::<Vec<SpoolSummary>>;
        let slots = vec![slot(
            1,
            true,
            Some("spoolman:workshop:filament:7"),
            "LDO Black",
        )];
        let status = printer_filament_status(&machine(slots), &unavailable, None);

        assert_eq!(status.slots[0].state, SlotState::Unknown);
        assert!(!status.needs_filament_swap);
        assert_eq!(status.filament_swap_reason, None);
        assert_eq!(status.filament_remaining_g, None);
    }

    #[test]
    fn loaded_matched_sums_spools_and_needs_no_swap() {
        let table = vec![(7, vec![spool(1, 480.0), spool(2, 310.0)])];
        let lookup = spoolman_lookup(&table);
        let slots = vec![slot(
            1,
            true,
            Some(" spoolman:workshop:filament:7 "),
            " LDO Black ",
        )];
        let status = printer_filament_status(&machine(slots), &lookup, None);

        let SlotState::Loaded {
            remaining_g,
            spool_ids,
            low,
        } = &status.slots[0].state
        else {
            panic!("expected loaded, got {:?}", status.slots[0].state);
        };
        assert_eq!(*remaining_g, 790.0);
        assert_eq!(spool_ids, &vec![1, 2]);
        assert!(!low);
        assert_eq!(status.slots[0].label, "LDO Black");
        assert_eq!(
            status.slots[0].filament_color_id.as_deref(),
            Some("spoolman:workshop:filament:7")
        );
        assert!(!status.needs_filament_swap);
        assert_eq!(status.filament_remaining_g, Some(790.0));
    }

    #[test]
    fn spoolman_knows_depleted_filament_reports_out_of_filament() {
        let table = vec![(9, vec![])];
        let lookup = spoolman_lookup(&table);
        let slots = vec![slot(
            1,
            true,
            Some("spoolman:workshop:filament:9"),
            "LDO Black",
        )];
        let status = printer_filament_status(&machine(slots), &lookup, None);

        let SlotState::Loaded {
            remaining_g, low, ..
        } = status.slots[0].state
        else {
            panic!("expected loaded, got {:?}", status.slots[0].state);
        };
        assert_eq!(remaining_g, 0.0);
        assert!(low);
        assert!(status.needs_filament_swap);
        assert_eq!(
            status.filament_swap_reason.as_deref(),
            Some("slot 1 is out of filament")
        );
        assert_eq!(status.filament_remaining_g, Some(0.0));
    }

    #[test]
    fn low_spool_flags_swap_with_grams_left() {
        let table = vec![(7, vec![spool(1, 40.0)])];
        let lookup = spoolman_lookup(&table);
        let slots = vec![slot(
            1,
            true,
            Some("spoolman:workshop:filament:7"),
            "LDO Black",
        )];
        let status = printer_filament_status(&machine(slots), &lookup, None);

        assert!(status.needs_filament_swap);
        assert_eq!(
            status.filament_swap_reason.as_deref(),
            Some("slot 1 is low (~40 g left)")
        );
        assert_eq!(status.filament_remaining_g, Some(40.0));
    }

    #[test]
    fn untracked_catalog_id_is_unknown_not_depleted() {
        let lookup = spoolman_lookup(&[]);
        let slots = vec![slot(
            1,
            true,
            Some("catalog:prusament-galaxy-black"),
            "Galaxy Black",
        )];
        let status = printer_filament_status(&machine(slots), &lookup, None);

        assert_eq!(status.slots[0].state, SlotState::Unknown);
        assert!(!status.needs_filament_swap);
        assert_eq!(status.filament_remaining_g, None);
    }

    #[test]
    fn host_runout_wins_over_full_inventory() {
        let table = vec![(7, vec![spool(1, 900.0)])];
        let lookup = spoolman_lookup(&table);
        let slots = vec![slot(
            1,
            true,
            Some("spoolman:workshop:filament:7"),
            "LDO Black",
        )];
        let mut host = PrinterHostStatus::offline("Filament runout detected");
        host.state = PrinterHostState::Paused;

        let status = printer_filament_status(&machine(slots), &lookup, Some(&host));

        assert!(status.needs_filament_swap);
        assert_eq!(
            status.filament_swap_reason.as_deref(),
            Some("printer reports filament runout: Filament runout detected")
        );
        // Inventory is still reported alongside the runout.
        assert_eq!(status.filament_remaining_g, Some(900.0));
    }

    #[test]
    fn unconfigured_slot_does_not_trigger_swap_but_empty_slot_does() {
        let slots = vec![slot(1, false, None, ""), slot(2, true, None, "")];
        let lookup = spoolman_lookup(&[]);
        let status = printer_filament_status(&machine(slots), &lookup, None);

        assert!(status.needs_filament_swap);
        // Only slot 2 (empty) is named; slot 1 is unconfigured.
        assert_eq!(
            status.filament_swap_reason.as_deref(),
            Some("no filament loaded in slot 2")
        );
    }

    #[test]
    fn machine_with_no_slots_needs_no_swap() {
        let lookup = spoolman_lookup(&[]);
        let status = printer_filament_status(&machine(vec![]), &lookup, None);

        assert!(status.slots.is_empty());
        assert!(!status.needs_filament_swap);
        assert_eq!(status.filament_swap_reason, None);
        assert_eq!(status.filament_remaining_g, None);
    }

    #[test]
    fn runout_detection_matches_dialects_and_ignores_unrelated() {
        for message in [
            "Filament runout detected",
            "filament run out",
            "Please load filament",
            "Filament sensor triggered",
            "Out of filament",
            "Filament jam",
        ] {
            assert!(host_reports_filament_runout(Some(
                &PrinterHostStatus::offline(message)
            )));
        }
        assert!(!host_reports_filament_runout(Some(
            &PrinterHostStatus::offline("Printing plate 3")
        )));
        assert!(!host_reports_filament_runout(None));
    }

    /// Pins the exact `\b…\b` truth table of the frozen TS `RUNOUT_PATTERN`
    /// (evaluated in node against `farm-filament.ts`). A substring matcher gets
    /// all three of these wrong in a different way, so each case is explicit.
    #[test]
    fn runout_honours_frozen_ts_word_boundaries() {
        // `load filament` must not fire from inside "Unload filament": the TS
        // `\b` before "load" sees the preceding "n".
        assert!(!host_reports_filament_runout(Some(
            &PrinterHostStatus::offline("Unload filament")
        )));
        // "Filament outlet fan" has no qualifier directly after "filament"; the
        // trailing `\b` rejects the "out" prefix of "outlet".
        assert!(!host_reports_filament_runout(Some(
            &PrinterHostStatus::offline("Filament outlet fan")
        )));
        // `filament\s*(out|…)` allows zero whitespace, so the run-together
        // spelling is a runout to TS.
        assert!(host_reports_filament_runout(Some(
            &PrinterHostStatus::offline("filamentout")
        )));
        // `\s*` also allows more than one separator character.
        assert!(host_reports_filament_runout(Some(
            &PrinterHostStatus::offline("filament   empty")
        )));
        // The literal "run out" alternative requires one plain space, exactly
        // as the TS regex spells it.
        assert!(!host_reports_filament_runout(Some(
            &PrinterHostStatus::offline("run  out")
        )));
    }

    /// Broader fixture-free parity corpus, each value checked by evaluating the
    /// frozen TS `RUNOUT_PATTERN` in node. Guards the boundary/`\s` corners the
    /// old substring matcher got wrong in both directions.
    #[test]
    fn runout_parity_corpus_matches_node_truth_table() {
        let cases: [(&str, bool); 12] = [
            ("Filament jammed", false),
            ("run-outage", false),
            ("pre-runout", true),
            ("filament\tout", true),
            ("filament\u{00a0}out", true),
            ("filament\u{feff}out", true),
            ("filament\u{85}out", false),
            ("filament_out", false),
            ("cfilamentout", false),
            ("OUT OF FILAMENT.", true),
            ("reload filament", false),
            ("unrunoutable", false),
        ];
        for (message, expected) in cases {
            assert_eq!(
                host_reports_filament_runout(Some(&PrinterHostStatus::offline(message))),
                expected,
                "message: {message:?}"
            );
        }
    }

    #[derive(serde::Deserialize)]
    struct GoldenFile {
        case: String,
        context: GoldenContext,
        input: GoldenInput,
        expected: GoldenExpected,
    }

    #[derive(serde::Deserialize)]
    struct GoldenContext {
        configured: bool,
        #[allow(dead_code)]
        physically_empty: bool,
    }

    #[derive(serde::Deserialize)]
    struct GoldenInput {
        machine: GoldenMachine,
        spools_by_color_id: std::collections::BTreeMap<String, Option<Vec<GoldenSpool>>>,
    }

    #[derive(serde::Deserialize)]
    struct GoldenMachine {
        loaded_filaments: Vec<GoldenSlotInput>,
    }

    #[derive(serde::Deserialize)]
    struct GoldenSlotInput {
        slot: u32,
        filament_color_id: Option<String>,
        #[serde(default)]
        label: String,
    }

    #[derive(serde::Deserialize)]
    struct GoldenSpool {
        spool_id: u64,
        remaining_g: f64,
    }

    #[derive(serde::Deserialize)]
    struct GoldenExpected {
        slots: Vec<GoldenSlotExpected>,
        needs_filament_swap: bool,
        filament_swap_reason: Option<String>,
        filament_remaining_g: Option<f64>,
    }

    #[derive(serde::Deserialize)]
    struct GoldenSlotExpected {
        slot: u32,
        label: String,
        filament_color_id: Option<String>,
        remaining_g: Option<f64>,
        spool_ids: Vec<u64>,
        empty: bool,
        low: bool,
    }

    fn load_farm_filament_goldens() -> Vec<GoldenFile> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/parity/farm-filament");
        let mut paths: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                (path.extension().and_then(|ext| ext.to_str()) == Some("json")).then_some(path)
            })
            .collect();
        paths.sort();
        paths
            .iter()
            .map(|path| {
                let text = std::fs::read_to_string(path)
                    .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
                serde_json::from_str(&text)
                    .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
            })
            .collect()
    }

    fn golden_expected_state(slot: &GoldenSlotExpected) -> SlotState {
        match slot.remaining_g {
            Some(remaining_g) => SlotState::Loaded {
                remaining_g,
                spool_ids: slot.spool_ids.clone(),
                low: slot.low,
            },
            None if slot.empty => SlotState::Empty,
            None => SlotState::Unknown,
        }
    }

    /// Drives every checked-in GRE-575 golden through the Rust derivation. The
    /// four "Keep" rows must match the frozen TS output exactly; the
    /// `no-slot-config` "Change" row must instead report `Unconfigured`, with no
    /// swap, no reason, and no total. `context.configured` alone decides that,
    /// because `empty-slot.json` has the same null printer id.
    #[test]
    fn slot_state_goldens_keep_four_cases_and_change_unconfigured() {
        let goldens = load_farm_filament_goldens();
        let cases: Vec<&str> = goldens.iter().map(|golden| golden.case.as_str()).collect();
        assert_eq!(
            cases,
            [
                "blank-filament-color-id",
                "empty-slot",
                "loaded-matched",
                "loaded-no-spoolman-match",
                "no-slot-config",
            ]
        );

        let no_config = goldens
            .iter()
            .find(|golden| golden.case == "no-slot-config")
            .unwrap_or_else(|| panic!("missing no-slot-config golden"));
        let empty = goldens
            .iter()
            .find(|golden| golden.case == "empty-slot")
            .unwrap_or_else(|| panic!("missing empty-slot golden"));
        assert!(!no_config.context.configured);
        assert!(empty.context.configured);
        assert_eq!(
            no_config.input.machine.loaded_filaments[0].filament_color_id,
            None
        );
        assert_eq!(
            empty.input.machine.loaded_filaments[0].filament_color_id,
            None
        );

        for golden in &goldens {
            let machine = Machine {
                loaded_filaments: golden
                    .input
                    .machine
                    .loaded_filaments
                    .iter()
                    .map(|slot| FilamentSlot {
                        slot: slot.slot,
                        configured: golden.context.configured,
                        filament_color_id: slot.filament_color_id.clone(),
                        label: slot.label.clone(),
                    })
                    .collect(),
            };
            let lookup = |color_id: &str| match golden.input.spools_by_color_id.get(color_id) {
                Some(Some(spools)) => Some(
                    spools
                        .iter()
                        .map(|summary| spool(summary.spool_id, summary.remaining_g))
                        .collect(),
                ),
                Some(None) | None => None,
            };
            let status = printer_filament_status(&machine, &lookup, None);

            if golden.case == "no-slot-config" {
                assert_eq!(status.slots[0].state, SlotState::Unconfigured);
                assert_eq!(status.slots[0].filament_color_id, None);
                assert!(!status.needs_filament_swap);
                assert_eq!(status.filament_swap_reason, None);
                assert_eq!(status.filament_remaining_g, None);
                continue;
            }

            assert!(golden.context.configured);
            assert_eq!(status.slots.len(), golden.expected.slots.len());
            for (actual, expected) in status.slots.iter().zip(&golden.expected.slots) {
                assert_eq!(actual.slot, expected.slot);
                assert_eq!(actual.label, expected.label);
                assert_eq!(actual.filament_color_id, expected.filament_color_id);
                assert_eq!(actual.state, golden_expected_state(expected));
            }
            assert_eq!(
                status.needs_filament_swap,
                golden.expected.needs_filament_swap
            );
            assert_eq!(
                status.filament_swap_reason,
                golden.expected.filament_swap_reason
            );
            assert_eq!(
                status.filament_remaining_g,
                golden.expected.filament_remaining_g
            );
        }
    }

    /// GRE-488's rule is about PP configuration, not the printer's report: an
    /// unconfigured slot stays `Unconfigured` even if the printer reports a
    /// perfectly valid, non-blank filament id.
    #[test]
    fn unconfigured_slot_ignores_non_blank_printer_reported_id() {
        let table = vec![(7, vec![spool(1, 900.0)])];
        let lookup = spoolman_lookup(&table);
        let slots = vec![slot(
            1,
            false,
            Some("spoolman:workshop:filament:7"),
            "LDO Black",
        )];
        let status = printer_filament_status(&machine(slots), &lookup, None);

        assert_eq!(status.slots[0].state, SlotState::Unconfigured);
        assert_eq!(status.slots[0].filament_color_id, None);
        assert!(!status.needs_filament_swap);
        assert_eq!(status.filament_swap_reason, None);
        assert_eq!(status.filament_remaining_g, None);
    }
}

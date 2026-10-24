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
/// Matches the frozen TypeScript `RUNOUT_PATTERN` with dependency-free substring
/// checks over a whitespace-collapsed lowercase message. Word boundaries are
/// approximated: a marker inside a larger word (e.g. "unrunoutable") is not a
/// realistic printer message.
pub fn host_reports_filament_runout(status: Option<&PrinterHostStatus>) -> bool {
    let Some(message) = status.and_then(|status| status.message.as_deref()) else {
        return false;
    };
    let message = message.trim();
    if message.is_empty() {
        return false;
    }
    let collapsed = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    const MARKERS: [&str; 11] = [
        "runout",
        "run out",
        "run-out",
        "filament out",
        "filament empty",
        "filament error",
        "filament jam",
        "out of filament",
        "load filament",
        "insert filament",
        "filament sensor",
    ];
    MARKERS.iter().any(|&marker| collapsed.contains(marker))
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
}

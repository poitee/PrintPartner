import type { ProfileSummary } from "@print-partner/contracts";
import type { IntegrationSummary } from "../../api/endpoints/integrations";
import type { PrinterMachine } from "../../api/endpoints/printers";

/** One Build, one printer, one host. Shared by the printer workspace tests. */
export const build = {
  id: 7,
  name: "Enclosure Build",
  order_number: null,
  special_request: null,
  part_count: 1,
  accepted_progress: { kind: "ready", total_units: 1, remaining_units: 1 },
  build_stale: false,
  freshness: {
    status: "current",
    accepted_input_set_id: 11,
    accepted_at: "2026-08-27T00:00:00.000Z",
  },
  archived_at: null,
  last_used_at: null,
} satisfies ProfileSummary;

export const printer = {
  id: "voron-one",
  name: "Voron One",
  model: "voron-250",
  bed_width_mm: 250,
  bed_depth_mm: 250,
  bed_height_mm: 250,
  margin_mm: 4,
  max_filament_slots: 1,
  loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
  integration_id: "moonraker-one",
} satisfies PrinterMachine;

export const host = {
  id: "moonraker-one",
  type: "moonraker",
  name: "Voron host",
  config: { base_url: "http://voron.local" },
  created_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
} satisfies IntegrationSummary;

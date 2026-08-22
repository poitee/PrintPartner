export type PrinterMachine = {
  id: string;
  name: string;
  model: string;
  bed_width_mm: number;
  bed_depth_mm: number;
  bed_height_mm: number | null;
  margin_mm: number;
  max_filament_slots: number;
  loaded_filaments: Array<{
    slot: number;
    filament_color_id: string | null;
    label: string;
  }>;
  /** Linked live host integration (Moonraker / PrusaLink). Absent = unbound. */
  integration_id?: string | null;
  /** Optional device id within the host (Moonraker uses "default"). */
  device_id?: string | null;
  preset_id?: string | null;
  preferred_slicer?: "orca" | "prusa" | "bambu" | null;
};

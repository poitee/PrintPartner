/**
 * PP-native starter profiles — bundled fallback profiles for when no slicer
 * container is configured.
 *
 * SPDX-License-Identifier: MIT
 * These profiles were written independently and are not derived from any
 * slicer vendor's config files.
 */

import type Database from "better-sqlite3";

const TENANT_ID = "default";
const SLICER_FORMAT = "pp_native";
const NOW = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Process profile definitions
// Each entry maps to one row in process_profiles.
// resolved_flat_config carries the authoritative flat key/value JSON that the
// UI and slicer bridge consume.
// ---------------------------------------------------------------------------

interface ProcessProfileDef {
  name: string;
  resolvedFlatConfig: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Printer (machine) profile definitions
// Each entry maps to one row in printer_profiles.
// ---------------------------------------------------------------------------

interface PrinterProfileDef {
  name: string;
  slicerFormat: string;
  resolvedFlatConfig: Record<string, unknown>;
}

const PRINTER_PROFILES: PrinterProfileDef[] = [
  {
    name: "Generic Klipper Machine",
    slicerFormat: "orca",
    resolvedFlatConfig: {
      nozzle_diameter_mm: 0.4,
      gcode_flavor: "klipper",
      extruder_count: 1,
      printer_model: "Generic Klipper",
      printer_variant: "0.4",
      description: "Generic Klipper/Voron-class machine profile (0.4mm nozzle).",
    },
  },
  {
    // Portable fallback for printers whose slicer isn't Orca (PrusaSlicer,
    // BambuStudio) and have no dedicated imported machine profile.
    name: "Generic FDM Machine",
    slicerFormat: "pp_native",
    resolvedFlatConfig: {
      nozzle_diameter_mm: 0.4,
      gcode_flavor: "marlin2",
      extruder_count: 1,
      printer_model: "Generic FDM",
      printer_variant: "0.4",
      description: "Generic Marlin-class FDM machine profile (0.4mm nozzle).",
    },
  },
];

const PROCESS_PROFILES: ProcessProfileDef[] = [
  {
    name: "PLA 0.2mm Quality",
    resolvedFlatConfig: {
      layer_height: 0.2,
      first_layer_height: 0.25,
      perimeters: 4,
      top_solid_layers: 5,
      bottom_solid_layers: 4,
      fill_density: 0.4,
      fill_pattern: "gyroid",
      support_material: false,
      support_material_auto: false,
      print_speed_mm_s: 100,
      first_layer_speed_mm_s: 40,
      travel_speed_mm_s: 200,
      bridge_speed_mm_s: 60,
      description: "Balanced quality PLA print at 0.2mm layer height.",
    },
  },
  {
    name: "PLA 0.2mm Draft",
    resolvedFlatConfig: {
      layer_height: 0.2,
      first_layer_height: 0.25,
      perimeters: 4,
      top_solid_layers: 4,
      bottom_solid_layers: 3,
      fill_density: 0.4,
      fill_pattern: "gyroid",
      support_material: false,
      support_material_auto: false,
      print_speed_mm_s: 160,
      first_layer_speed_mm_s: 50,
      travel_speed_mm_s: 250,
      bridge_speed_mm_s: 80,
      description: "Fast draft PLA print at 0.2mm layer height.",
    },
  },
  {
    name: "PETG 0.2mm",
    resolvedFlatConfig: {
      layer_height: 0.2,
      first_layer_height: 0.25,
      perimeters: 4,
      top_solid_layers: 5,
      bottom_solid_layers: 4,
      fill_density: 0.4,
      fill_pattern: "gyroid",
      support_material: false,
      support_material_auto: false,
      print_speed_mm_s: 80,
      first_layer_speed_mm_s: 35,
      travel_speed_mm_s: 180,
      bridge_speed_mm_s: 50,
      description: "Standard PETG profile at 0.2mm layer height.",
    },
  },
  {
    name: "ABS/ASA 0.2mm",
    resolvedFlatConfig: {
      layer_height: 0.2,
      first_layer_height: 0.25,
      perimeters: 4,
      top_solid_layers: 5,
      bottom_solid_layers: 4,
      fill_density: 0.4,
      fill_pattern: "gyroid",
      support_material: false,
      support_material_auto: false,
      print_speed_mm_s: 80,
      first_layer_speed_mm_s: 30,
      travel_speed_mm_s: 180,
      bridge_speed_mm_s: 50,
      description: "Standard ABS/ASA profile at 0.2mm layer height. Enclosure recommended.",
    },
  },
  {
    name: "ABS/ASA 0.15mm Fine",
    resolvedFlatConfig: {
      layer_height: 0.15,
      first_layer_height: 0.2,
      perimeters: 4,
      top_solid_layers: 6,
      bottom_solid_layers: 5,
      fill_density: 0.4,
      fill_pattern: "gyroid",
      support_material: false,
      support_material_auto: false,
      print_speed_mm_s: 60,
      first_layer_speed_mm_s: 25,
      travel_speed_mm_s: 160,
      bridge_speed_mm_s: 40,
      description: "Fine detail ABS/ASA profile at 0.15mm layer height. Enclosure required.",
    },
  },
  {
    name: "TPU 0.2mm",
    resolvedFlatConfig: {
      layer_height: 0.2,
      first_layer_height: 0.25,
      perimeters: 4,
      top_solid_layers: 5,
      bottom_solid_layers: 4,
      fill_density: 0.4,
      fill_pattern: "gyroid",
      support_material: false,
      support_material_auto: false,
      print_speed_mm_s: 30,
      first_layer_speed_mm_s: 20,
      travel_speed_mm_s: 100,
      bridge_speed_mm_s: 25,
      description: "TPU flexible filament at 0.2mm layer height. Direct drive recommended.",
    },
  },
];

// ---------------------------------------------------------------------------
// Filament profile definitions
// Each entry maps to one row in filament_profiles.
// ---------------------------------------------------------------------------

interface FilamentProfileDef {
  name: string;
  materialType: string;
  materialTier: number;
  nozzleTempC: number;
  bedTempC: number;
  fanPct: number;
  extrusionMultiplier: string;
  pressureAdvance: string;
  retraction: string;
  resolvedFlatConfig: Record<string, unknown>;
}

const FILAMENT_PROFILES: FilamentProfileDef[] = [
  {
    name: "Generic PLA",
    materialType: "PLA",
    materialTier: 1,
    nozzleTempC: 220,
    bedTempC: 60,
    fanPct: 100,
    extrusionMultiplier: "1.0",
    pressureAdvance: "0.04",
    retraction: JSON.stringify({ length_mm: 0.8, speed_mm_s: 45, z_hop_mm: 0.2 }),
    resolvedFlatConfig: {
      nozzle_temp_c: 220,
      nozzle_temp_first_layer_c: 225,
      bed_temp_c: 60,
      bed_temp_first_layer_c: 65,
      fan_pct: 100,
      fan_pct_first_layer: 0,
      fan_min_speed_pct: 30,
      extrusion_multiplier: 1.0,
      pressure_advance: 0.04,
      retraction_length_mm: 0.8,
      retraction_speed_mm_s: 45,
      z_hop_mm: 0.2,
      min_print_temp_c: 190,
      max_print_temp_c: 240,
    },
  },
  {
    name: "Generic PETG",
    materialType: "PETG",
    materialTier: 1,
    nozzleTempC: 240,
    bedTempC: 80,
    fanPct: 50,
    extrusionMultiplier: "1.0",
    pressureAdvance: "0.05",
    retraction: JSON.stringify({ length_mm: 0.6, speed_mm_s: 35, z_hop_mm: 0.3 }),
    resolvedFlatConfig: {
      nozzle_temp_c: 240,
      nozzle_temp_first_layer_c: 245,
      bed_temp_c: 80,
      bed_temp_first_layer_c: 85,
      fan_pct: 50,
      fan_pct_first_layer: 0,
      fan_min_speed_pct: 20,
      extrusion_multiplier: 1.0,
      pressure_advance: 0.05,
      retraction_length_mm: 0.6,
      retraction_speed_mm_s: 35,
      z_hop_mm: 0.3,
      min_print_temp_c: 220,
      max_print_temp_c: 260,
    },
  },
  {
    name: "Generic ABS/ASA",
    materialType: "ABS",
    materialTier: 1,
    nozzleTempC: 250,
    bedTempC: 100,
    fanPct: 0,
    extrusionMultiplier: "1.0",
    pressureAdvance: "0.04",
    retraction: JSON.stringify({ length_mm: 0.5, speed_mm_s: 40, z_hop_mm: 0.4 }),
    resolvedFlatConfig: {
      nozzle_temp_c: 250,
      nozzle_temp_first_layer_c: 255,
      bed_temp_c: 100,
      bed_temp_first_layer_c: 110,
      fan_pct: 0,
      fan_pct_first_layer: 0,
      fan_min_speed_pct: 0,
      extrusion_multiplier: 1.0,
      pressure_advance: 0.04,
      retraction_length_mm: 0.5,
      retraction_speed_mm_s: 40,
      z_hop_mm: 0.4,
      min_print_temp_c: 230,
      max_print_temp_c: 270,
    },
  },
  {
    name: "Generic TPU",
    materialType: "TPU",
    materialTier: 1,
    nozzleTempC: 230,
    bedTempC: 30,
    fanPct: 0,
    extrusionMultiplier: "1.0",
    pressureAdvance: "0.0",
    retraction: JSON.stringify({ length_mm: 0.0, speed_mm_s: 25, z_hop_mm: 0.0 }),
    resolvedFlatConfig: {
      nozzle_temp_c: 230,
      nozzle_temp_first_layer_c: 235,
      bed_temp_c: 30,
      bed_temp_first_layer_c: 35,
      fan_pct: 0,
      fan_pct_first_layer: 0,
      fan_min_speed_pct: 0,
      extrusion_multiplier: 1.0,
      pressure_advance: 0.0,
      retraction_length_mm: 0.0,
      retraction_speed_mm_s: 25,
      z_hop_mm: 0.0,
      min_print_temp_c: 210,
      max_print_temp_c: 250,
    },
  },
];

/**
 * Seeds PP-native starter profiles into the database if they are not already
 * present. Uses INSERT OR IGNORE so it is safe to call on every startup — it
 * will not overwrite profiles a user has edited or renamed.
 */
export function seedStarterProfiles(sqlite: Database.Database): void {
  const now = NOW();

  // ---- printer (machine) profiles -----------------------------------------
  const upsertPrinter = sqlite.prepare(`
    INSERT OR IGNORE INTO printer_profiles
      (tenant_id, name, slicer_format, extruder_count, resolved_flat_config, imported_at)
    VALUES
      (@tenantId, @name, @slicerFormat, @extruderCount, @resolvedFlatConfig, @importedAt)
  `);

  const insertPrinterMany = sqlite.transaction((profiles: PrinterProfileDef[]) => {
    for (const m of profiles) {
      upsertPrinter.run({
        tenantId: TENANT_ID,
        name: m.name,
        slicerFormat: m.slicerFormat,
        extruderCount: Number(m.resolvedFlatConfig.extruder_count ?? 1),
        resolvedFlatConfig: JSON.stringify(m.resolvedFlatConfig),
        importedAt: now,
      });
    }
  });

  insertPrinterMany(PRINTER_PROFILES);

  // ---- process profiles ---------------------------------------------------
  const upsertProcess = sqlite.prepare(`
    INSERT OR IGNORE INTO process_profiles
      (tenant_id, name, slicer_format, compatible_printers, resolved_flat_config, imported_at)
    VALUES
      (@tenantId, @name, @slicerFormat, @compatiblePrinters, @resolvedFlatConfig, @importedAt)
  `);

  const insertProcessMany = sqlite.transaction((profiles: ProcessProfileDef[]) => {
    for (const p of profiles) {
      upsertProcess.run({
        tenantId: TENANT_ID,
        name: p.name,
        slicerFormat: SLICER_FORMAT,
        compatiblePrinters: null,
        resolvedFlatConfig: JSON.stringify(p.resolvedFlatConfig),
        importedAt: now,
      });
    }
  });

  insertProcessMany(PROCESS_PROFILES);

  // ---- filament profiles --------------------------------------------------
  const upsertFilament = sqlite.prepare(`
    INSERT OR IGNORE INTO filament_profiles
      (tenant_id, name, material_type, material_tier, nozzle_temp_c, bed_temp_c,
       fan_pct, extrusion_multiplier, pressure_advance, retraction,
       resolved_flat_config, imported_at)
    VALUES
      (@tenantId, @name, @materialType, @materialTier, @nozzleTempC, @bedTempC,
       @fanPct, @extrusionMultiplier, @pressureAdvance, @retraction,
       @resolvedFlatConfig, @importedAt)
  `);

  const insertFilamentMany = sqlite.transaction((profiles: FilamentProfileDef[]) => {
    for (const f of profiles) {
      upsertFilament.run({
        tenantId: TENANT_ID,
        name: f.name,
        materialType: f.materialType,
        materialTier: f.materialTier,
        nozzleTempC: f.nozzleTempC,
        bedTempC: f.bedTempC,
        fanPct: f.fanPct,
        extrusionMultiplier: f.extrusionMultiplier,
        pressureAdvance: f.pressureAdvance,
        retraction: f.retraction,
        resolvedFlatConfig: JSON.stringify(f.resolvedFlatConfig),
        importedAt: now,
      });
    }
  });

  insertFilamentMany(FILAMENT_PROFILES);
}

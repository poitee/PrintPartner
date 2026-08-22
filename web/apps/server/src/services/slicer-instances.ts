export type SlicerInstanceKind = "orca" | "prusa" | "bambu" | "custom";

export type SlicerDialect = "orca_json" | "bambu_json" | "prusa_ini";

export type SlicerSyncKind = "orca" | "prusa" | "bambu";

export function dialectToSyncKind(dialect: SlicerDialect): SlicerSyncKind {
  if (dialect === "prusa_ini") return "prusa";
  if (dialect === "bambu_json") return "bambu";
  return "orca";
}

export function defaultWatchDirs(dialect: SlicerDialect): {
  printer: string;
  process: string;
  filament: string;
} {
  if (dialect === "prusa_ini") {
    return {
      printer: ".config/PrusaSlicer/printer",
      process: ".config/PrusaSlicer/print",
      filament: ".config/PrusaSlicer/filament",
    };
  }
  if (dialect === "bambu_json") {
    return {
      printer: ".config/BambuStudio/user/default/machine",
      process: ".config/BambuStudio/user/default/process",
      filament: ".config/BambuStudio/user/default/filament",
    };
  }
  return {
    printer: ".config/OrcaSlicer/user/default/machine",
    process: ".config/OrcaSlicer/user/default/process",
    filament: ".config/OrcaSlicer/user/default/filament",
  };
}

export type SlicerInstancePreset = {
  kind: Exclude<SlicerInstanceKind, "custom">;
  name: string;
  dialect: SlicerDialect;
  gui_url: string;
  watch_path: string;
};

export function stockPresets(env: NodeJS.ProcessEnv = process.env): SlicerInstancePreset[] {
  return [
    {
      kind: "orca",
      name: "OrcaSlicer",
      dialect: "orca_json",
      gui_url: "http://orca.home",
      watch_path: env.SLICER_ORCA_DIR?.trim() || "/slicer-profiles/orca",
    },
    {
      kind: "prusa",
      name: "PrusaSlicer",
      dialect: "prusa_ini",
      gui_url: "http://prusa.home",
      watch_path: env.SLICER_PRUSA_DIR?.trim() || "/slicer-profiles/prusa",
    },
    {
      kind: "bambu",
      name: "BambuStudio",
      dialect: "bambu_json",
      gui_url: "http://bambu.home",
      watch_path: env.SLICER_BAMBU_DIR?.trim() || "/slicer-profiles/bambu",
    },
  ];
}

/** Allow only http(s) GUI URLs (empty string clears the link). */
export function validateSlicerGuiUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "gui_url must be a valid http(s) URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "gui_url must use http or https";
  }
  return null;
}

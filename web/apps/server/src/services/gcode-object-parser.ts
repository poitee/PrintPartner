import { basename } from "node:path";

/**
 * Parses object names from gcode/printer APIs and matches them to STL filenames.
 * Handles OrcaSlicer/BambuStudio (EXCLUDE_OBJECT format) and PrusaSlicer (M486/quoted EXCLUDE_OBJECT).
 */

export type ParsedGcodeObject = {
  name: string; // raw NAME from gcode/API
  stlBasename: string; // extracted filename e.g. "a_drive_frame_lower.stl"
  copyIndex: number; // 0-based copy index (0,1,2... for qty>1)
  format: "exclude_object_orca" | "exclude_object_prusa" | "m486" | "unknown";
};

export type PlateMatch = {
  stlBasename: string; // lowercase, normalized
  count: number; // how many copies on plate
  objects: ParsedGcodeObject[];
};

// OrcaSlicer: "a_drive_frame_lower.stl_id_0_copy_0"
const ORCA_REGEX = /^(.+)_id_(\d+)_copy_(\d+)$/;

// PrusaSlicer Instance suffix: "__Instance_1_" or "_Instance_1_"
const PRUSA_INSTANCE_REGEX = /_+Instance_(\d+)_?$/i;

/**
 * Parse a single object NAME string.
 *
 * OrcaSlicer/BambuStudio: "a_drive_frame_lower.stl_id_0_copy_0"
 *   -> regex ^(.+)_id_(\d+)_copy_(\d+)$ — group 1 = stlBasename (with .stl), group 3 = copyIndex
 *
 * PrusaSlicer Klipper: "'a_drive_frame_lower_stl'" or "'a_drive_frame_lower_stl__Instance_1_'"
 *   (quoted, dots→_, spaces→_)
 *
 * PrusaSlicer M486: "a_drive_frame_lower_stl" (same but unquoted, no Instance suffix for single)
 */
export function parseGcodeObjectName(raw: string): ParsedGcodeObject {
  // Try OrcaSlicer format first: ends with _id_N_copy_M
  const orcaMatch = ORCA_REGEX.exec(raw);
  if (orcaMatch) {
    return {
      name: raw,
      stlBasename: orcaMatch[1]!,
      copyIndex: parseInt(orcaMatch[3]!, 10),
      format: "exclude_object_orca",
    };
  }

  // Check for PrusaSlicer quoted format (single quotes around the name)
  const isQuoted = raw.startsWith("'") && raw.endsWith("'");
  const format: ParsedGcodeObject["format"] = isQuoted
    ? "exclude_object_prusa"
    : "m486";

  // Strip surrounding single quotes
  let inner = isQuoted ? raw.slice(1, -1) : raw;

  // Extract Instance number if present
  let copyIndex = 0;
  const instanceMatch = PRUSA_INSTANCE_REGEX.exec(inner);
  if (instanceMatch) {
    // Instance N is 1-based; convert to 0-based
    copyIndex = Math.max(0, parseInt(instanceMatch[1]!, 10) - 1);
    inner = inner.slice(0, instanceMatch.index);
    // Clean up trailing underscores
    inner = inner.replace(/_+$/, "");
  }

  // Replace trailing _stl with .stl (PrusaSlicer replaces . with _ in filenames)
  // but only if the last segment looks like _stl (could also be _3mf etc)
  const stlBasename = inner.replace(/_stl$/i, ".stl");

  return {
    name: raw,
    stlBasename,
    copyIndex,
    format,
  };
}

/**
 * Given an array of raw object name strings (from Moonraker exclude_object.objects[].name
 * or parsed from gcode EXCLUDE_OBJECT_DEFINE lines), return a map of stlBasename→PlateMatch.
 * Groups multiple copies of the same part together.
 *
 * Handles both OrcaSlicer format ("part.stl_id_0_copy_0") and
 * PrusaSlicer objects_info format ("part.stl" / "part.stl (Instance 2)").
 */
export function groupObjectsByPart(names: string[]): Map<string, PlateMatch> {
  // Detect objects_info format: no _id_N_copy_M pattern and no single-quote wrapping
  // but may have " (Instance N)" suffix
  const isObjectsInfoFormat =
    names.length > 0 &&
    !names.some((n) => ORCA_REGEX.test(n)) &&
    !names.some((n) => n.startsWith("'"));

  if (isObjectsInfoFormat) {
    return parseObjectsInfoNames(names);
  }

  const result = new Map<string, PlateMatch>();
  for (const raw of names) {
    const parsed = parseGcodeObjectName(raw);
    const key = parsed.stlBasename.toLowerCase();
    const existing = result.get(key);
    if (existing) {
      existing.count += 1;
      existing.objects.push(parsed);
    } else {
      result.set(key, {
        stlBasename: key,
        count: 1,
        objects: [parsed],
      });
    }
  }
  return result;
}

// PrusaSlicer objects_info Instance suffix: " (Instance N)"
const OBJECTS_INFO_INSTANCE_REGEX = /^(.*) \(Instance (\d+)\)$/;

/**
 * Parse object names from PrusaSlicer objects_info JSON format.
 * Input: raw objects array from objects_info JSON.
 * Format: "part.stl" (single) or "part.stl (Instance N)" (multiple, 1-based).
 * Returns the same Map<string, PlateMatch> as groupObjectsByPart.
 */
export function parseObjectsInfoNames(names: string[]): Map<string, PlateMatch> {
  const result = new Map<string, PlateMatch>();
  for (const raw of names) {
    let stlBasename = raw;
    let copyIndex = 0;

    const instanceMatch = OBJECTS_INFO_INSTANCE_REGEX.exec(raw);
    if (instanceMatch) {
      stlBasename = instanceMatch[1]!;
      // Instance N is 1-based; convert to 0-based
      copyIndex = Math.max(0, parseInt(instanceMatch[2]!, 10) - 1);
    }

    const parsed: ParsedGcodeObject = {
      name: raw,
      stlBasename,
      copyIndex,
      format: "exclude_object_prusa",
    };

    const key = stlBasename.toLowerCase();
    const existing = result.get(key);
    if (existing) {
      existing.count += 1;
      existing.objects.push(parsed);
    } else {
      result.set(key, {
        stlBasename: key,
        count: 1,
        objects: [parsed],
      });
    }
  }
  return result;
}

/**
 * Match plate objects against a flat list of STL filenames from the parts library.
 * Returns matches: stlBasename -> array of part filenames that match (case-insensitive basename comparison).
 * Also handles PrusaSlicer dot-substitution: "a_drive_frame_lower_stl" matches "a_drive_frame_lower.stl"
 */
export function matchObjectsToFilenames(
  plateMatches: Map<string, PlateMatch>,
  libraryFilenames: string[], // all unique filenames across all parts in all profiles
): Map<string, string[]> {
  // Build a normalized lookup map for library filenames
  // key: normalized basename (lowercase) -> original filename
  const libraryNorm = new Map<string, string[]>();
  for (const filename of libraryFilenames) {
    const base = basename(filename).toLowerCase();
    const existing = libraryNorm.get(base);
    if (existing) {
      if (!existing.includes(filename)) existing.push(filename);
    } else {
      libraryNorm.set(base, [filename]);
    }

    // Also index with _stl instead of .stl for Prusa format matching
    const prusaKey = base.replace(/\.stl$/i, "_stl");
    if (prusaKey !== base) {
      const existingPrusa = libraryNorm.get(prusaKey);
      if (existingPrusa) {
        if (!existingPrusa.includes(filename)) existingPrusa.push(filename);
      } else {
        libraryNorm.set(prusaKey, [filename]);
      }
    }
  }

  const libraryStems = new Map<string, string[]>();
  const normalizedStem = (name: string): string => {
    let stem = basename(name).toLowerCase();
    for (let i = 0; i < 4; i += 1) {
      const next = stem.replace(/\.(stl|3mf|gcode|gco|bgcode)$/i, "");
      if (next === stem) break;
      stem = next;
    }
    return stem.replace(/_stl$/i, "");
  };
  for (const filename of libraryFilenames) {
    const stem = normalizedStem(filename);
    const existing = libraryStems.get(stem);
    if (existing) {
      if (!existing.includes(filename)) existing.push(filename);
    } else {
      libraryStems.set(stem, [filename]);
    }
  }

  const result = new Map<string, string[]>();
  for (const [stlKey, _plateMatch] of plateMatches) {
    const matches: string[] = [];
    const addMatches = (rows: string[] | undefined) => {
      for (const filename of rows ?? []) {
        if (!matches.includes(filename)) matches.push(filename);
      }
    };

    // Try direct match
    addMatches(libraryNorm.get(stlKey));

    // Try with .stl -> _stl substitution (for Prusa format plate keys that already got .stl)
    const withUnderscoreStl = stlKey.replace(/\.stl$/i, "_stl");
    if (withUnderscoreStl !== stlKey) {
      addMatches(libraryNorm.get(withUnderscoreStl));
    }

    // Try _stl -> .stl substitution (for Prusa format where key has _stl suffix)
    const withDotStl = stlKey.replace(/_stl$/i, ".stl");
    if (withDotStl !== stlKey) {
      addMatches(libraryNorm.get(withDotStl));
    }

    if (matches.length === 0) {
      const stem = normalizedStem(stlKey);
      addMatches(libraryStems.get(stem));
      if (matches.length === 0) {
        addMatches(libraryStems.get(stem.replace(/_\d{1,3}$/u, "")));
      }
    }

    result.set(stlKey, matches);
  }

  return result;
}

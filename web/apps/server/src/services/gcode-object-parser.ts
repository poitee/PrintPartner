import {
  interpretSlicedObjectName,
  matchSlicedObjectName,
} from "@print-partner/domain";

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
  const interpreted = interpretSlicedObjectName(raw);
  const isQuoted = raw.startsWith("'") && raw.endsWith("'");
  const format: ParsedGcodeObject["format"] =
    interpreted.wrapper === "orca_copy"
      ? "exclude_object_orca"
      : isQuoted || interpreted.wrapper !== "plain"
        ? "exclude_object_prusa"
        : "m486";

  return {
    name: raw,
    stlBasename: interpreted.unwrappedName.replace(/_stl$/i, ".stl"),
    copyIndex: interpreted.copyIndex ?? 0,
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

/**
 * Parse object names from PrusaSlicer objects_info JSON format.
 * Input: raw objects array from objects_info JSON.
 * Format: "part.stl" (single) or "part.stl (Instance N)" (multiple, 1-based).
 * Returns the same Map<string, PlateMatch> as groupObjectsByPart.
 */
export function parseObjectsInfoNames(names: string[]): Map<string, PlateMatch> {
  return groupObjectsByPart(names);
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
  const result = new Map<string, string[]>();
  for (const [stlKey, _plateMatch] of plateMatches) {
    const match = matchSlicedObjectName(stlKey, libraryFilenames);
    result.set(
      stlKey,
      match.kind === "matched"
        ? [match.filename]
        : match.kind === "ambiguous"
          ? [...match.filenames]
          : [],
    );
  }

  return result;
}

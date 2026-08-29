/**
 * Client-side parse of already-sliced files for object labels.
 * Supports EXCLUDE_OBJECT_DEFINE (Moonraker/Klipper), M486 labels, and
 * .3mf / .gcode.3mf object@name attributes. Never talks to a print host.
 */

import JSZip from "jszip";

export type SlicedObjectSource =
  | "exclude_object_define"
  | "m486"
  | "3mf_object"
  | "cura_mesh"
  | "comment";

export type ParsedSlicedObject = {
  name: string;
  source: SlicedObjectSource;
};

type ParsedSlicedObjectsBase = {
  objects: ParsedSlicedObject[];
  /** Placed or printed object occurrences in source order. */
  names: string[];
  unlabeled: boolean;
  /** Plate preview thumbnail as a data URL (PNG), if found in .gcode.3mf. */
  thumbnailUrl?: string;
  /** Estimated print time string extracted from gcode header comments. */
  printTime?: string;
  /** Total filament weight in grams from gcode header comments. */
  filamentWeightG?: number;
};

export type ParseSlicedObjectsResult =
  | (ParsedSlicedObjectsBase & {
      format: "3mf";
      /** Named project objects that Bambu/Orca did not assign to any plate. */
      projectOnlyObjects: ParsedSlicedObject[];
      projectOnlyNames: string[];
    })
  | (ParsedSlicedObjectsBase & {
      format: "gcode" | "bgcode" | "unknown";
    });

const EXCLUDE_LINE = /^\s*EXCLUDE_OBJECT_DEFINE\b([^\n]*)$/gim;
const EXCLUDE_NAME_EQ = /\bNAME\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s,]+))/i;
const EXCLUDE_NAME_JSON = /EXCLUDE_OBJECT_DEFINE\b[^\n]*?"name"\s*:\s*"([^"]+)"/gi;
const M486_A_QUOTED = /\bM486\b[^\n]*?\bA\s*"([^"]+)"/gi;
const M486_A_BARE = /\bM486\b[^\n]*?\bA\s*([^\s;]+)/gi;
const PRINTING_OBJECT = /;\s*printing object\s+(\S+?)(?:\s+id:\d+)?(?:\s+copy\s+\d+)?\s*$/gim;
const CURA_MESH = /^;\s*MESH\s*:\s*(.+?)\s*$/gim;

const OBJECT_NAME_ATTR = /<object\b[^>]*\bname\s*=\s*"([^"]+)"/gi;
const OBJECT_TAG = /<object\b([^>]*)>/gi;
const BUILD_BLOCK = /<build\b[^>]*>([\s\S]*?)<\/build>/i;
const BUILD_ITEM = /<item\b[^>]*\bobjectid\s*=\s*"([^"]+)"[^>]*\/?\s*>/gi;
const BAMBU_OBJECT_BLOCK = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
const BAMBU_PLATE_BLOCK = /<plate\b[^>]*>([\s\S]*?)<\/plate>/gi;
const BAMBU_MODEL_INSTANCE_BLOCK =
  /<model_instance\b[^>]*>([\s\S]*?)<\/model_instance>/gi;
const XML_ID_ATTR = /\bid\s*=\s*"([^"]+)"/i;
const MODEL_METADATA_NAME_ATTR =
  /<metadata\b(?=[^>]*\bkey\s*=\s*"name")[^>]*\bvalue\s*=\s*"([^"]+)"/gi;
const MODEL_METADATA_OBJECT_ID_ATTR =
  /<metadata\b(?=[^>]*\bkey\s*=\s*"object_id")[^>]*\bvalue\s*=\s*"([^"]+)"/gi;

function pushUnique(
  out: ParsedSlicedObject[],
  seen: Set<string>,
  name: string,
  source: SlicedObjectSource,
): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name: trimmed, source });
}

/** Extract object labels from G-code / comment text. */
export function parseGcodeObjectText(text: string): ParsedSlicedObject[] {
  const out: ParsedSlicedObject[] = [];
  const seen = new Set<string>();

  EXCLUDE_NAME_JSON.lastIndex = 0;
  let excludeJson: RegExpExecArray | null;
  while ((excludeJson = EXCLUDE_NAME_JSON.exec(text)) != null) {
    pushUnique(out, seen, excludeJson[1] ?? "", "exclude_object_define");
  }
  EXCLUDE_LINE.lastIndex = 0;
  let excludeLine: RegExpExecArray | null;
  while ((excludeLine = EXCLUDE_LINE.exec(text)) != null) {
    const match = EXCLUDE_NAME_EQ.exec(excludeLine[1] ?? "");
    pushUnique(
      out,
      seen,
      match?.[1] ?? match?.[2] ?? match?.[3] ?? "",
      "exclude_object_define",
    );
  }

  M486_A_QUOTED.lastIndex = 0;
  let m486: RegExpExecArray | null;
  while ((m486 = M486_A_QUOTED.exec(text)) != null) {
    pushUnique(out, seen, m486[1] ?? "", "m486");
  }
  M486_A_BARE.lastIndex = 0;
  while ((m486 = M486_A_BARE.exec(text)) != null) {
    const raw = (m486[1] ?? "").replace(/^"+|"+$/g, "");
    // Skip pure numeric M486 A indexes (A0 / A1) — those are not labels.
    if (/^\d+$/.test(raw)) continue;
    pushUnique(out, seen, raw, "m486");
  }

  PRINTING_OBJECT.lastIndex = 0;
  let comment: RegExpExecArray | null;
  while ((comment = PRINTING_OBJECT.exec(text)) != null) {
    pushUnique(out, seen, comment[1] ?? "", "comment");
  }

  CURA_MESH.lastIndex = 0;
  let cura: RegExpExecArray | null;
  while ((cura = CURA_MESH.exec(text)) != null) {
    const name = (cura[1] ?? "").trim();
    if (/^NONMESH$/i.test(name)) continue;
    pushUnique(out, seen, name, "cura_mesh");
  }

  return out;
}

/** Extract estimated print time and filament weight from gcode header comments. */
export function parseGcodeStats(
  text: string,
): { printTime?: string; filamentWeightG?: number } {
  // Estimated print time — OrcaSlicer / PrusaSlicer / BambuStudio emit variants:
  //   ; estimated printing time (normal mode) = 1h 23m 45s
  //   ; estimated printing time = 1h 23m 45s
  //   ; print_time = 4950
  const timeMatch =
    /^;\s*estimated printing time(?:\s*\([^)]*\))?\s*=\s*(.+)$/im.exec(text) ??
    /^;\s*print_time\s*=\s*(\d+)\s*$/im.exec(text);

  let printTime: string | undefined;
  if (timeMatch) {
    const raw = timeMatch[1]!.trim();
    // If it's raw seconds (from print_time = N), convert to h/m/s
    if (/^\d+$/.test(raw)) {
      const secs = parseInt(raw, 10);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      printTime = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    } else {
      printTime = raw;
    }
  }

  // Filament weight:
  //   ; total filament used [g] = 12.34
  //   ; filament used [g] = 12.34
  //   ; total weight = 12.34 [g]   (some slicers)
  const weightMatch =
    /^;\s*(?:total\s+)?filament\s+(?:used\s+)?\[g\]\s*=\s*([\d.]+)/im.exec(text) ??
    /^;\s*total\s+weight\s*=\s*([\d.]+)\s*\[g\]/im.exec(text);

  const filamentWeightG = weightMatch ? parseFloat(weightMatch[1]!) : undefined;

  return {
    printTime,
    filamentWeightG: filamentWeightG != null && !isNaN(filamentWeightG)
      ? filamentWeightG
      : undefined,
  };
}

/** Convert a Uint8Array of PNG bytes to a base64 data URL. */
function pngToDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}


/** Pull object@name from 3MF model XML. */
export function parse3mfObjectNamesFromXml(xml: string): ParsedSlicedObject[] {
  const namesById = new Map<string, string>();
  OBJECT_TAG.lastIndex = 0;
  let objectTag: RegExpExecArray | null;
  while ((objectTag = OBJECT_TAG.exec(xml)) != null) {
    const attrs = objectTag[1] ?? "";
    const id = /\bid\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const name = /\bname\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (id && name) namesById.set(id, name);
  }

  const build = BUILD_BLOCK.exec(xml)?.[1];
  if (build != null) {
    const placed: ParsedSlicedObject[] = [];
    BUILD_ITEM.lastIndex = 0;
    let item: RegExpExecArray | null;
    while ((item = BUILD_ITEM.exec(build)) != null) {
      const name = namesById.get(item[1] ?? "");
      if (name) placed.push({ name, source: "3mf_object" });
    }
    if (placed.length > 0) return placed;
  }

  const out: ParsedSlicedObject[] = [];
  const seen = new Set<string>();
  OBJECT_NAME_ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OBJECT_NAME_ATTR.exec(xml)) != null) {
    pushUnique(out, seen, match[1] ?? "", "3mf_object");
  }
  return out;
}

type BambuObjectInventory = Readonly<{
  plateObjects: ParsedSlicedObject[];
  projectOnlyObjects: ParsedSlicedObject[];
}>;

/** Separate plate-assigned objects from project-only Bambu Studio objects. */
function parseBambuModelSettingsObjectNames(xml: string): BambuObjectInventory {
  const namesByObjectId = new Map<string, string>();
  BAMBU_OBJECT_BLOCK.lastIndex = 0;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = BAMBU_OBJECT_BLOCK.exec(xml)) != null) {
    const objectId = XML_ID_ATTR.exec(objectMatch[1] ?? "")?.[1];
    const objectMetadata = (objectMatch[2] ?? "").split(/<part\b/i, 1)[0] ?? "";
    MODEL_METADATA_NAME_ATTR.lastIndex = 0;
    const name = MODEL_METADATA_NAME_ATTR.exec(objectMetadata)?.[1];
    if (objectId != null && name != null) namesByObjectId.set(objectId, name);
  }

  const plateObjects: ParsedSlicedObject[] = [];
  const placedObjectIds = new Set<string>();
  let foundPlate = false;
  BAMBU_PLATE_BLOCK.lastIndex = 0;
  let plateMatch: RegExpExecArray | null;
  while ((plateMatch = BAMBU_PLATE_BLOCK.exec(xml)) != null) {
    foundPlate = true;
    BAMBU_MODEL_INSTANCE_BLOCK.lastIndex = 0;
    let instanceMatch: RegExpExecArray | null;
    while ((instanceMatch = BAMBU_MODEL_INSTANCE_BLOCK.exec(plateMatch[1] ?? "")) != null) {
      MODEL_METADATA_OBJECT_ID_ATTR.lastIndex = 0;
      const objectId = MODEL_METADATA_OBJECT_ID_ATTR.exec(instanceMatch[1] ?? "")?.[1];
      const name = namesByObjectId.get(objectId ?? "")?.trim();
      if (objectId && name) {
        placedObjectIds.add(objectId);
        plateObjects.push({ name, source: "3mf_object" });
      }
    }
  }

  if (!foundPlate) {
    for (const name of namesByObjectId.values()) {
      plateObjects.push({ name, source: "3mf_object" });
    }
    return { plateObjects, projectOnlyObjects: [] };
  }

  const projectOnlyObjects = [...namesByObjectId.entries()]
    .filter(([objectId]) => !placedObjectIds.has(objectId))
    .map(([, name]) => ({ name, source: "3mf_object" }) satisfies ParsedSlicedObject);
  return { plateObjects, projectOnlyObjects };
}

function detectFormat(filename: string): ParseSlicedObjectsResult["format"] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gcode.3mf") || lower.endsWith(".3mf")) return "3mf";
  if (lower.endsWith(".bgcode")) return "bgcode";
  if (lower.endsWith(".gcode") || lower.endsWith(".gco")) return "gcode";
  return "unknown";
}

/** Best-effort ASCII harvest from binary buffers (bgcode / mixed). */
export function extractAsciiChunks(bytes: Uint8Array, minRun = 12): string {
  const parts: string[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    if (end - start >= minRun) {
      parts.push(new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, end)));
    }
    start = -1;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) {
      if (start < 0) start = i;
    } else {
      flush(i);
    }
  }
  flush(bytes.length);
  return parts.join("\n");
}

async function parse3mfArchive(
  bytes: ArrayBuffer,
): Promise<{
  objects: ParsedSlicedObject[];
  projectOnlyObjects: ParsedSlicedObject[];
  thumbnailUrl?: string;
  printTime?: string;
  filamentWeightG?: number;
}> {
  const zip = await JSZip.loadAsync(bytes);
  const out: ParsedSlicedObject[] = [];
  const seen = new Set<string>();
  let thumbnailUrl: string | undefined;
  let printTime: string | undefined;
  let filamentWeightG: number | undefined;

  const merge = (rows: ParsedSlicedObject[], preserveOccurrences = false) => {
    for (const row of rows) {
      const key = row.name.trim().toLowerCase();
      if (preserveOccurrences) {
        if (!key) continue;
        seen.add(key);
        out.push(row);
      } else {
        pushUnique(out, seen, row.name, row.source);
      }
    }
  };

  // Collect thumbnail paths in priority order: plate_1.png first, then others.
  const thumbnailPaths: string[] = [];

  for (const [path] of Object.entries(zip.files)) {
    const lower = path.toLowerCase();
    // OrcaSlicer stores plate thumbnails as Metadata/plate_1.png, plate_2.png, etc.
    if (/^metadata\/plate_\d+\.png$/i.test(lower)) {
      thumbnailPaths.push(path);
    }
  }

  // Sort so plate_1.png comes first.
  thumbnailPaths.sort((a, b) => {
    const numA = parseInt(/plate_(\d+)/i.exec(a)?.[1] ?? "99", 10);
    const numB = parseInt(/plate_(\d+)/i.exec(b)?.[1] ?? "99", 10);
    return numA - numB;
  });

  if (thumbnailPaths.length > 0) {
    try {
      const pngBytes = await zip.files[thumbnailPaths[0]!]!.async("uint8array");
      thumbnailUrl = pngToDataUrl(pngBytes);
    } catch {
      /* skip if unreadable */
    }
  }

  const bambuSettingsEntry = Object.entries(zip.files).find(
    ([path, entry]) =>
      !entry.dir && path.toLowerCase() === "metadata/model_settings.config",
  )?.[1];
  let bambuInventory: BambuObjectInventory | null = null;
  if (bambuSettingsEntry != null) {
    try {
      bambuInventory = parseBambuModelSettingsObjectNames(
        await bambuSettingsEntry.async("string"),
      );
      merge(bambuInventory.plateObjects, true);
    } catch {
      /* fall back to standard 3MF object names */
    }
  }

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const lower = path.toLowerCase();
    if (
      bambuInventory === null &&
      (lower.endsWith(".model") || lower.endsWith(".xml"))
    ) {
      try {
        const xml = await entry.async("string");
        const rows = parse3mfObjectNamesFromXml(xml);
        merge(rows, BUILD_BLOCK.test(xml));
      } catch {
        /* skip unreadable entries */
      }
    } else if (lower === "metadata/model_settings.config") {
      continue;
    } else if (
      lower.endsWith(".gcode") ||
      lower.endsWith(".gco") ||
      lower.endsWith(".bgcode")
    ) {
      try {
        const text =
          lower.endsWith(".bgcode")
            ? extractAsciiChunks(await entry.async("uint8array"))
            : await entry.async("string");
        merge(parseGcodeObjectText(text));
        // Parse stats from the first gcode entry that has them.
        if (printTime == null && filamentWeightG == null) {
          const stats = parseGcodeStats(text);
          printTime = stats.printTime;
          filamentWeightG = stats.filamentWeightG;
        }
      } catch {
        /* skip */
      }
    }
  }
  return {
    objects: out,
    projectOnlyObjects: bambuInventory?.projectOnlyObjects ?? [],
    thumbnailUrl,
    printTime,
    filamentWeightG,
  };
}

function finishFlat(
  objects: ParsedSlicedObject[],
  format: "gcode" | "bgcode" | "unknown",
  extras?: Pick<ParseSlicedObjectsResult, "thumbnailUrl" | "printTime" | "filamentWeightG">,
): ParseSlicedObjectsResult {
  const names = objects.map((o) => o.name);
  return {
    objects,
    names,
    format,
    unlabeled: names.length === 0,
    ...extras,
  };
}

/**
 * Parse a user-chosen sliced file for object names.
 * Local only — no host download.
 */
export async function parseSlicedObjectsFile(file: File): Promise<ParseSlicedObjectsResult> {
  const format = detectFormat(file.name);
  const buffer = await file.arrayBuffer();

  if (format === "3mf") {
    const { objects, projectOnlyObjects, thumbnailUrl, printTime, filamentWeightG } =
      await parse3mfArchive(buffer);
    const names = objects.map((object) => object.name);
    return {
      objects,
      names,
      format: "3mf",
      unlabeled: names.length === 0,
      projectOnlyObjects,
      projectOnlyNames: projectOnlyObjects.map((object) => object.name),
      thumbnailUrl,
      printTime,
      filamentWeightG,
    };
  }

  if (format === "bgcode") {
    const ascii = extractAsciiChunks(new Uint8Array(buffer));
    const stats = parseGcodeStats(ascii);
    return finishFlat(parseGcodeObjectText(ascii), "bgcode", stats);
  }

  // .gcode / .gco / unknown — decode as text
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const stats = parseGcodeStats(text);
  return finishFlat(parseGcodeObjectText(text), format === "unknown" ? "gcode" : format, stats);
}

/**
 * Print-file bytes for tests: real 3MF containers, hostile ones, and binary
 * G-code. Shared so the classifier's own tests and the routes that upload or
 * read print files argue about exactly the same bytes.
 */
import { strToU8, zipSync } from "fflate";

export const MODEL_XML =
  '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources>' +
  '<object id="1" name="bracket" type="model"><mesh/></object></resources>' +
  '<build><item objectid="1"/></build></model>';

export function threeMf(entries: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([name, body]) => [name, strToU8(body)])),
  );
}

/** A 3MF a slicer has already turned into printer instructions. */
export function slicedThreeMf(): Uint8Array {
  return threeMf({
    "[Content_Types].xml": "<Types/>",
    "3D/3dmodel.model": MODEL_XML,
    "Metadata/project_settings.config": "{}",
    "Metadata/plate_1.gcode": "G28\nG1 X10 Y10 E1\n",
  });
}

/** A 3MF that is still a slicer's working state, so no printer can run it. */
export function slicerProjectThreeMf(): Uint8Array {
  return threeMf({
    "[Content_Types].xml": "<Types/>",
    "3D/3dmodel.model": MODEL_XML,
    "Metadata/Slic3r_PE.config": "; layer_height = 0.2\n",
  });
}

/**
 * Build a central directory by hand so a test can lie about entry sizes, entry
 * counts, and external attributes the way a hostile archive would.
 */
export function hostileZip(
  entries: ReadonlyArray<{
    name: string;
    uncompressedSize?: number;
    externalAttributes?: number;
  }>,
  options: { declaredEntryCount?: number } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const names = entries.map((entry) => encoder.encode(entry.name));
  const local = new Uint8Array(30);
  new DataView(local.buffer).setUint32(0, 0x04034b50, true);

  const centralSize = names.reduce((total, name) => total + 46 + name.byteLength, 0);
  const output = new Uint8Array(local.byteLength + centralSize + 22);
  output.set(local, 0);
  const view = new DataView(output.buffer);
  let cursor = local.byteLength;
  for (const [index, entry] of entries.entries()) {
    const name = names[index]!;
    view.setUint32(cursor, 0x02014b50, true);
    view.setUint32(cursor + 24, entry.uncompressedSize ?? 0, true);
    view.setUint16(cursor + 28, name.byteLength, true);
    view.setUint32(cursor + 38, entry.externalAttributes ?? 0, true);
    output.set(name, cursor + 46);
    cursor += 46 + name.byteLength;
  }
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 8, entries.length, true);
  view.setUint16(cursor + 10, options.declaredEntryCount ?? entries.length, true);
  view.setUint32(cursor + 12, centralSize, true);
  view.setUint32(cursor + 16, local.byteLength, true);
  return output;
}

export function bgcode(blocks: ReadonlyArray<{ payload: number }>): Uint8Array {
  const total = 10 + blocks.reduce((sum, block) => sum + 8 + 2 + block.payload, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("GCDE"), 0);
  view.setUint32(4, 1, true);
  view.setUint16(8, 0, true);
  let cursor = 10;
  for (const block of blocks) {
    view.setUint16(cursor, 1, true);
    view.setUint16(cursor + 2, 0, true);
    view.setUint32(cursor + 4, block.payload, true);
    view.setUint16(cursor + 8, 0, true);
    cursor += 8 + 2 + block.payload;
  }
  return bytes;
}

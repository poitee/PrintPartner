import { readFileSync } from "node:fs";

export type StlBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

function updateBounds(
  bounds: StlBounds,
  x: number,
  y: number,
  z: number,
): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function finalizeBounds(bounds: StlBounds): StlBounds {
  bounds.widthMm = bounds.maxX - bounds.minX;
  bounds.depthMm = bounds.maxY - bounds.minY;
  bounds.heightMm = bounds.maxZ - bounds.minZ;
  return bounds;
}

function emptyBounds(): StlBounds {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
    widthMm: 0,
    depthMm: 0,
    heightMm: 0,
  };
}

function parseAsciiStlBounds(text: string): StlBounds | null {
  const bounds = emptyBounds();
  const vertexRe = /vertex\s+([-+eE0-9.]+)\s+([-+eE0-9.]+)\s+([-+eE0-9.]+)/g;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = vertexRe.exec(text)) !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (![x, y, z].every(Number.isFinite)) return null;
    updateBounds(bounds, x, y, z);
    count += 1;
  }
  if (count === 0 || count % 3 !== 0) return null;
  return finalizeBounds(bounds);
}

function parseBinaryStlBounds(buf: Buffer): StlBounds | null {
  if (buf.length < 84) return null;
  const triCount = buf.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  if (buf.length < expected) return null;
  const bounds = emptyBounds();
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    offset += 12;
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(offset);
      const y = buf.readFloatLE(offset + 4);
      const z = buf.readFloatLE(offset + 8);
      if (![x, y, z].every(Number.isFinite)) return null;
      updateBounds(bounds, x, y, z);
      offset += 12;
    }
    offset += 2;
  }
  if (!Number.isFinite(bounds.minX)) return null;
  return finalizeBounds(bounds);
}

/** Read STL header or full parse for axis-aligned bounding box (mm). */
export function readStlBounds(stlPath: string): StlBounds | null {
  const buf = readFileSync(stlPath);
  const header = buf.subarray(0, 80).toString("utf8", 0, 80).trim().toLowerCase();
  if (header.startsWith("solid")) {
    const ascii = parseAsciiStlBounds(buf.toString("utf8"));
    if (ascii) return ascii;
  }
  return parseBinaryStlBounds(buf);
}

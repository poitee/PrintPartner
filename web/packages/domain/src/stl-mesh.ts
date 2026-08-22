import { readFileSync } from "node:fs";
import type { StlBounds } from "./stl-bounds.js";

export type StlMesh = {
  vertices: Array<[number, number, number]>;
  faces: Array<[number, number, number]>;
  bounds: StlBounds;
};

export type StlMeshDimensionsUm = Readonly<{
  widthUm: number;
  depthUm: number;
  heightUm: number;
}>;

export function stlMeshDimensionsUm(mesh: StlMesh): StlMeshDimensionsUm | null {
  const dimensions = {
    widthUm: Math.round(mesh.bounds.widthMm * 1_000),
    depthUm: Math.round(mesh.bounds.depthMm * 1_000),
    heightUm: Math.round(mesh.bounds.heightMm * 1_000),
  };
  return Object.values(dimensions).every((value) => Number.isSafeInteger(value) && value > 0)
    ? dimensions
    : null;
}

function parseAsciiStlMesh(text: string): StlMesh | null {
  const vertices: Array<[number, number, number]> = [];
  const faces: Array<[number, number, number]> = [];
  const vertexRe = /vertex\s+([-+eE0-9.]+)\s+([-+eE0-9.]+)\s+([-+eE0-9.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = vertexRe.exec(text)) !== null) {
    const vertex: [number, number, number] = [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ];
    if (!vertex.every(Number.isFinite)) return null;
    vertices.push(vertex);
  }
  if (vertices.length === 0 || vertices.length % 3 !== 0) return null;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    faces.push([i, i + 1, i + 2]);
  }
  if (!faces.length) return null;
  const bounds = readStlBoundsFromVertices(vertices);
  return { vertices, faces, bounds };
}

function readStlBoundsFromVertices(vertices: Array<[number, number, number]>): StlBounds {
  const bounds = {
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
  for (const [x, y, z] of vertices) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
    bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  bounds.widthMm = bounds.maxX - bounds.minX;
  bounds.depthMm = bounds.maxY - bounds.minY;
  bounds.heightMm = bounds.maxZ - bounds.minZ;
  return bounds;
}

function parseBinaryStlMesh(buf: Buffer): StlMesh | null {
  if (buf.length < 84) return null;
  const triCount = buf.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  if (buf.length < expected) return null;
  const vertices: Array<[number, number, number]> = [];
  const faces: Array<[number, number, number]> = [];
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    offset += 12;
    const base = vertices.length;
    for (let v = 0; v < 3; v++) {
      const vertex: [number, number, number] = [
        buf.readFloatLE(offset),
        buf.readFloatLE(offset + 4),
        buf.readFloatLE(offset + 8),
      ];
      if (!vertex.every(Number.isFinite)) return null;
      vertices.push(vertex);
      offset += 12;
    }
    faces.push([base, base + 1, base + 2]);
    offset += 2;
  }
  if (!faces.length) return null;
  return { vertices, faces, bounds: readStlBoundsFromVertices(vertices) };
}

function exactBinaryStlSize(buf: Buffer): number | null {
  if (buf.length < 84) return null;
  const triangles = buf.readUInt32LE(80);
  const size = 84 + triangles * 50;
  return Number.isSafeInteger(size) && size === buf.length ? size : null;
}

function parseStrictAsciiStlMesh(buf: Buffer): StlMesh | null {
  const text = buf.toString("utf8").trim();
  const document = /^solid[^\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)endsolid[^\r\n]*$/.exec(text);
  if (!document) return null;
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const facet = new RegExp(
    `facet\\s+normal\\s+${number}\\s+${number}\\s+${number}\\s+outer\\s+loop\\s+` +
      `vertex\\s+${number}\\s+${number}\\s+${number}\\s+` +
      `vertex\\s+${number}\\s+${number}\\s+${number}\\s+` +
      `vertex\\s+${number}\\s+${number}\\s+${number}\\s+endloop\\s+endfacet`,
    "g",
  );
  const body = document[1]!;
  if (body.replace(facet, "").trim().length !== 0) return null;
  return parseAsciiStlMesh(`solid accepted\n${body}\nendsolid accepted`);
}

export function parseStlMesh(bytes: Uint8Array): StlMesh | null {
  const buf = Buffer.from(bytes);
  const header = buf.subarray(0, 80).toString("utf8", 0, 80).trim().toLowerCase();
  if (header.startsWith("solid")) {
    const ascii = parseAsciiStlMesh(buf.toString("utf8"));
    if (ascii) return ascii;
  }
  return parseBinaryStlMesh(buf);
}

export function parseAcceptedStlMesh(bytes: Uint8Array): StlMesh | null {
  const buf = Buffer.from(bytes);
  if (exactBinaryStlSize(buf) != null) return parseBinaryStlMesh(buf);
  return parseStrictAsciiStlMesh(buf);
}

export function loadStlMesh(stlPath: string): StlMesh | null {
  return parseStlMesh(readFileSync(stlPath));
}

export function translateMesh(
  mesh: StlMesh,
  dx: number,
  dy: number,
  dz: number,
): StlMesh {
  const vertices = mesh.vertices.map(
    ([x, y, z]) => [x + dx, y + dy, z + dz] as [number, number, number],
  );
  return {
    vertices,
    faces: mesh.faces.map((f) => [...f] as [number, number, number]),
    bounds: readStlBoundsFromVertices(vertices),
  };
}

/** Place mesh on bed: min corner at (x, y, 0). */
export function placeMeshOnBed(mesh: StlMesh, xMm: number, yMm: number): StlMesh {
  const dx = xMm - mesh.bounds.minX;
  const dy = yMm - mesh.bounds.minY;
  const dz = -mesh.bounds.minZ;
  return translateMesh(mesh, dx, dy, dz);
}

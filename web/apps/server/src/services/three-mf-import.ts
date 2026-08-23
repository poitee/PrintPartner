import { Unzip, UnzipInflate } from "fflate";
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

export const DEFAULT_THREE_MF_LIMITS = {
  maxModelBytes: 64 * 1024 * 1024,
  maxObjects: 2_000,
  maxVertices: 5_000_000,
  maxTriangles: 10_000_000,
  maxOutputBytes: 256 * 1024 * 1024,
} as const;

export type ThreeMfImportLimits = Readonly<{
  maxModelBytes?: number;
  maxObjects?: number;
  maxVertices?: number;
  maxTriangles?: number;
  maxOutputBytes?: number;
}>;
export type ThreeMfImportedFile = Readonly<{
  relativePath: string;
  objectId: string;
  objectName: string;
  triangleCount: number;
  byteSize: number;
}>;
export type ThreeMfImportResult = Readonly<{
  objectCount: number;
  files: ThreeMfImportedFile[];
}>;

function readBoundedModelDocument(bytes: Buffer, maxBytes: number): Buffer {
  let found = false;
  let complete = false;
  let failure: Error | null = null;
  let total = 0;
  const chunks: Buffer[] = [];
  const unzip = new Unzip((file) => {
    if (found || !file.name.toLowerCase().endsWith(".model")) {
      file.terminate();
      return;
    }
    found = true;
    if (file.originalSize != null && file.originalSize > maxBytes) {
      failure = new Error("3MF model document exceeds the size limit");
      file.terminate();
      return;
    }
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = error;
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        failure = new Error("3MF model document exceeds the size limit");
        file.terminate();
        return;
      }
      chunks.push(Buffer.from(chunk));
      complete = final;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length && !failure; offset += 4_096) {
      const end = Math.min(bytes.length, offset + 4_096);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch {
    throw new Error("File is not a valid 3MF package");
  }
  if (failure) throw failure;
  if (!found || !complete) throw new Error("File is not a valid 3MF package: model document is missing");
  return Buffer.concat(chunks, total);
}

const UNIT_TO_MM: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  meter: 1_000,
  inch: 25.4,
  foot: 304.8,
};

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const expression = /(?:^|\s)([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(tag)) !== null) {
    result.set(match[1]!.toLowerCase(), decodeXml(match[2] ?? match[3] ?? ""));
  }
  return result;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|quot|apos|lt|gt));/gi, (_all, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as const)[String(named).toLowerCase() as "amp"];
  });
}

function slug(value: string, fallback: string): string {
  const cleaned = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function finiteNumber(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`3MF contains an invalid ${label}`);
  return parsed;
}

function normal(a: readonly number[], b: readonly number[], c: readonly number[]): [number, number, number] {
  const ux = b[0]! - a[0]!;
  const uy = b[1]! - a[1]!;
  const uz = b[2]! - a[2]!;
  const vx = c[0]! - a[0]!;
  const vy = c[1]! - a[1]!;
  const vz = c[2]! - a[2]!;
  const cross: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const length = Math.hypot(...cross);
  return length === 0 ? [0, 0, 0] : cross.map((value) => value / length) as [number, number, number];
}

function writeAsciiStl(path: string, name: string, vertices: Array<[number, number, number]>, faces: Array<[number, number, number]>, maxBytes: number): number {
  const descriptor = openSync(path, "w");
  let bytes = 0;
  const append = (lines: string[]): void => {
    const output = `${lines.join("\n")}\n`;
    bytes += Buffer.byteLength(output);
    if (bytes > maxBytes) throw new Error("3MF derived STL output exceeds the size limit");
    writeSync(descriptor, output);
  };
  try {
    append([`solid ${name}`]);
  for (const face of faces) {
    const points = face.map((index) => vertices[index]!);
    const n = normal(points[0]!, points[1]!, points[2]!);
      append([
        `  facet normal ${n.join(" ")}`,
        "    outer loop",
        ...points.map((point) => `      vertex ${point.join(" ")}`),
        "    endloop",
        "  endfacet",
      ]);
    }
    append([`endsolid ${name}`]);
    closeSync(descriptor);
    return bytes;
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(path);
    throw error;
  }
}

export function extractThreeMfMeshes(
  bytes: Buffer,
  outputDir: string,
  sourceName: string,
  limits: ThreeMfImportLimits = {},
): ThreeMfImportResult {
  const bounds = { ...DEFAULT_THREE_MF_LIMITS, ...limits };
  if (!Object.values(bounds).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("3MF import limits must be positive integers");
  }
  const modelBytes = readBoundedModelDocument(bytes, bounds.maxModelBytes);
  const xml = modelBytes.toString("utf8");
  const modelTag = /<model\b([^>]*)>/i.exec(xml)?.[1] ?? "";
  const unit = attributes(modelTag).get("unit")?.toLowerCase() ?? "millimeter";
  const scale = UNIT_TO_MM[unit];
  if (scale == null) throw new Error(`3MF uses unsupported unit: ${unit}`);

  const objects = [...xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object\s*>/gi)]
    .filter((match) => /<mesh\b/i.test(match[2]!));
  if (objects.length > bounds.maxObjects) {
    throw new Error(`3MF has too many mesh objects (${objects.length}, max ${bounds.maxObjects})`);
  }
  if (!objects.length) throw new Error("3MF contains no directly printable mesh objects");

  const project = slug(basename(sourceName, ".3mf"), "project");
  const usedNames = new Map<string, number>();
  const files: ThreeMfImportedFile[] = [];
  let totalVertices = 0;
  let totalTriangles = 0;
  let totalOutputBytes = 0;
  for (const [objectIndex, object] of objects.entries()) {
    const objectAttributes = attributes(object[1]!);
    const objectId = objectAttributes.get("id") ?? String(objectIndex + 1);
    const objectName = objectAttributes.get("name") ?? objectAttributes.get("partnumber") ?? `object-${objectId}`;
    const vertices = [...object[2]!.matchAll(/<vertex\b([^>]*)\/?\s*>/gi)].map((match) => {
      const attrs = attributes(match[1]!);
      return [
        finiteNumber(attrs.get("x"), "vertex x") * scale,
        finiteNumber(attrs.get("y"), "vertex y") * scale,
        finiteNumber(attrs.get("z"), "vertex z") * scale,
      ] as [number, number, number];
    });
    const faces = [...object[2]!.matchAll(/<triangle\b([^>]*)\/?\s*>/gi)].map((match) => {
      const attrs = attributes(match[1]!);
      const face = ["v1", "v2", "v3"].map((key) => finiteNumber(attrs.get(key), `triangle ${key}`));
      if (!face.every((index) => Number.isSafeInteger(index) && index >= 0 && index < vertices.length)) {
        throw new Error("3MF triangle references an invalid vertex");
      }
      return face as [number, number, number];
    });
    totalVertices += vertices.length;
    totalTriangles += faces.length;
    if (totalVertices > bounds.maxVertices) throw new Error("3MF has too many vertices");
    if (totalTriangles > bounds.maxTriangles) throw new Error("3MF has too many triangles");
    if (!vertices.length || !faces.length) continue;
    const baseName = slug(objectName, `object-${objectId}`);
    const occurrence = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, occurrence);
    const filename = `${baseName}${occurrence > 1 ? `-${occurrence}` : ""}.stl`;
    const relativePath = `_3mf/${project}/${filename}`;
    mkdirSync(join(outputDir, "_3mf", project), { recursive: true });
    const byteSize = writeAsciiStl(
      join(outputDir, relativePath),
      baseName,
      vertices,
      faces,
      bounds.maxOutputBytes - totalOutputBytes,
    );
    totalOutputBytes += byteSize;
    files.push({ relativePath, objectId, objectName, triangleCount: faces.length, byteSize });
  }
  if (!files.length) throw new Error("3MF contains no non-empty printable mesh objects");
  return { objectCount: files.length, files };
}

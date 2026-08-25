import { strToU8, zipSync } from "fflate";
import type { StlMesh } from "./stl-mesh.js";

export type AcceptedPlate3mfObject = Readonly<{
  token: string;
  objectName: string;
  xUm: number;
  yUm: number;
  mesh: StlMesh;
}>;

export const MAX_ACCEPTED_PLATES = 65_534;

export function acceptedPlateCountWithinZipLimit(count: number): boolean {
  return Number.isInteger(count) && count >= 0 && count <= MAX_ACCEPTED_PLATES;
}

export function acceptedPlateZipEpoch(): Date {
  return new Date(1980, 0, 1, 0, 0, 0, 0);
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

function number(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

type WeldedMesh = Readonly<{
  vertices: readonly string[];
  triangles: readonly (readonly [number, number, number])[];
}>;

/**
 * 3MF meshes are indexed, not triangle soup: a shared edge has to be the same
 * pair of vertex indices in both of its triangles. STL carries three fresh
 * vertices per facet, so emitting its vertices verbatim leaves every edge
 * unshared - slicers read that as a shell of disconnected facets. Weld vertices
 * that serialize to identical coordinates, and drop the zero-area facets that
 * welding collapses (3MF requires a triangle's three indices to be distinct).
 */
function weldMesh(object: AcceptedPlate3mfObject): WeldedMesh {
  const { mesh } = object;
  const xMm = object.xUm / 1_000;
  const yMm = object.yUm / 1_000;
  const coordinates = new Map<string, number>();
  const vertices: string[] = [];
  const triangles: Array<readonly [number, number, number]> = [];
  const coordinate = (index: number): string | null => {
    const vertex = mesh.vertices[index];
    if (!vertex) return null;
    const [x, y, z] = vertex;
    return `x="${number(xMm + (x - mesh.bounds.minX))}" y="${number(yMm + (y - mesh.bounds.minY))}" z="${number(z - mesh.bounds.minZ)}"`;
  };
  const intern = (key: string): number => {
    const existing = coordinates.get(key);
    if (existing !== undefined) return existing;
    const id = vertices.length;
    coordinates.set(key, id);
    vertices.push(key);
    return id;
  };
  for (const [a, b, c] of mesh.faces) {
    const first = coordinate(a);
    const second = coordinate(b);
    const third = coordinate(c);
    if (first === null || second === null || third === null) continue;
    if (first === second || second === third || first === third) continue;
    triangles.push([intern(first), intern(second), intern(third)]);
  }
  return { vertices, triangles };
}

function modelXml(objects: readonly AcceptedPlate3mfObject[]): string {
  const resources = objects.map((object, index) => {
    const id = index + 1;
    const welded = weldMesh(object);
    const vertices = welded.vertices
      .map((vertex) => `        <vertex ${vertex}/>`)
      .join("\n");
    const triangles = welded.triangles
      .map(([v1, v2, v3]) => `        <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`)
      .join("\n");
    return `    <object id="${id}" name="${xml(object.objectName)}" partnumber="${xml(object.token)}" type="model">
      <mesh>
      <vertices>
${vertices}
      </vertices>
      <triangles>
${triangles}
      </triangles>
      </mesh>
    </object>`;
  }).join("\n");
  const items = objects
    .map((object, index) => `    <item objectid="${index + 1}" partnumber="${xml(object.token)}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
${resources}
  </resources>
  <build>
${items}
  </build>
</model>`;
}

export function encodeAcceptedPlate3mf(objects: readonly AcceptedPlate3mfObject[]): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(relationships),
    "3D/3dmodel.model": strToU8(modelXml(objects)),
  }, { level: 6, mtime: acceptedPlateZipEpoch() });
}

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

function modelXml(objects: readonly AcceptedPlate3mfObject[]): string {
  const resources = objects.map((object, index) => {
    const id = index + 1;
    const xMm = object.xUm / 1_000;
    const yMm = object.yUm / 1_000;
    const vertices = object.mesh.vertices
      .map(([x, y, z]) => `        <vertex x="${number(xMm + (x - object.mesh.bounds.minX))}" y="${number(yMm + (y - object.mesh.bounds.minY))}" z="${number(z - object.mesh.bounds.minZ)}"/>`)
      .join("\n");
    const triangles = object.mesh.faces
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

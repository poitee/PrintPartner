import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  acceptedPlateCountWithinZipLimit,
  encodeAcceptedPlate3mf,
  MAX_ACCEPTED_PLATES,
} from "./accepted-plate-3mf.js";

const mesh = {
  vertices: [[-2, -3, -4], [1, -3, -4], [-2, 2, 6]] as Array<[number, number, number]>,
  faces: [[0, 1, 2]] as Array<[number, number, number]>,
  bounds: {
    minX: -2, minY: -3, minZ: -4,
    maxX: 1, maxY: 2, maxZ: 6,
    widthMm: 3, depthMm: 5, heightMm: 10,
  },
};

describe("encodeAcceptedPlate3mf", () => {
  it("reserves one classic ZIP entry for the manifest", () => {
    expect(acceptedPlateCountWithinZipLimit(MAX_ACCEPTED_PLATES)).toBe(true);
    expect(acceptedPlateCountWithinZipLimit(MAX_ACCEPTED_PLATES + 1)).toBe(false);
  });
  it("writes exact accepted identity and absolute minimum coordinates", () => {
    const bytes = encodeAcceptedPlate3mf([{
      token: "ppu_00000000000000000000000000000001",
      objectName: "Bracket & Clip",
      xUm: 1_250,
      yUm: 2_500,
      mesh,
    }]);
    const entries = unzipSync(bytes);
    expect(Object.keys(entries)).toEqual(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
    const xml = strFromU8(entries["3D/3dmodel.model"]!);
    expect(xml).toContain('object id="1" name="Bracket &amp; Clip" partnumber="ppu_00000000000000000000000000000001"');
    expect(xml).toContain('item objectid="1" partnumber="ppu_00000000000000000000000000000001"');
    expect(xml).toContain('vertex x="1.25" y="2.5" z="0"');
    expect(xml).not.toContain("-0");
    const header = Buffer.from(bytes);
    expect(header.readUInt16LE(10)).toBe(0);
    expect(header.readUInt16LE(12)).toBe(33);
  });

  it("assigns local IDs and emits byte-identical packages", () => {
    const objects = [1, 2].map((index) => ({
      token: `ppu_${index.toString(16).padStart(32, "0")}`,
      objectName: `Bracket ${index}`,
      xUm: index * 1_000,
      yUm: 0,
      mesh,
    }));
    const first = encodeAcceptedPlate3mf(objects);
    expect(first).toEqual(encodeAcceptedPlate3mf(objects));
    const xml = strFromU8(unzipSync(first)["3D/3dmodel.model"]!);
    expect([...xml.matchAll(/<object id="(\d+)"/g)].map((match) => match[1])).toEqual(["1", "2"]);
  });
});

import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  extractAsciiChunks,
  parse3mfObjectNamesFromXml,
  parseGcodeObjectText,
  parseSlicedObjectsFile,
} from "./parseSlicedObjects";

describe("parseGcodeObjectText", () => {
  it("parses EXCLUDE_OBJECT_DEFINE NAME= forms (dummy spike)", () => {
    const text = `
; header
EXCLUDE_OBJECT_DEFINE NAME=bracket_01
EXCLUDE_OBJECT_DEFINE NAME=bracket_02 CENTER=10,10
EXCLUDE_OBJECT_DEFINE NAME=spacer_01
EXCLUDE_OBJECT_DEFINE NAME=spacer_02
EXCLUDE_OBJECT_DEFINE NAME=spacer_03
EXCLUDE_OBJECT_DEFINE NAME=bracket_03
EXCLUDE_OBJECT_DEFINE NAME=bracket_04
EXCLUDE_OBJECT_DEFINE NAME=bracket_05
`;
    const names = parseGcodeObjectText(text).map((o) => o.name);
    expect(names).toEqual([
      "bracket_01",
      "bracket_02",
      "spacer_01",
      "spacer_02",
      "spacer_03",
      "bracket_03",
      "bracket_04",
      "bracket_05",
    ]);
  });

  it("parses JSON-ish EXCLUDE_OBJECT_DEFINE name fields", () => {
    const text = `EXCLUDE_OBJECT_DEFINE {"name":"hinge_01","center":[1,2],"polygon":[]}`;
    expect(parseGcodeObjectText(text).map((o) => o.name)).toEqual(["hinge_01"]);
  });

  it("parses M486 A labels and skips numeric indexes", () => {
    const text = `
M486 T0
M486 A"Door_Latch_01"
M486 S1
M486 A0
M486 APulley_01
`;
    const rows = parseGcodeObjectText(text);
    expect(rows.map((o) => o.name)).toEqual(["Door_Latch_01", "Pulley_01"]);
    expect(rows.every((r) => r.source === "m486")).toBe(true);
  });

  it("parses ; printing object comments", () => {
    const text = `; printing object corner_bracket_01 id:0 copy 0`;
    expect(parseGcodeObjectText(text)[0]?.name).toBe("corner_bracket_01");
  });
});

describe("parse3mfObjectNamesFromXml", () => {
  it("reads object name attributes", () => {
    const xml = `<?xml version="1.0"?>
<model><resources>
  <object id="1" name="bracket_01.stl" type="model"/>
  <object id="2" name="spacer_01.stl" type="model"/>
</resources></model>`;
    expect(parse3mfObjectNamesFromXml(xml).map((o) => o.name)).toEqual([
      "bracket_01.stl",
      "spacer_01.stl",
    ]);
  });
});

describe("parseSlicedObjectsFile", () => {
  it("parses a .gcode File", async () => {
    const body = `EXCLUDE_OBJECT_DEFINE NAME=a_01\nEXCLUDE_OBJECT_DEFINE NAME=b_01\n`;
    const file = new File([body], "plate.gcode", { type: "text/plain" });
    const result = await parseSlicedObjectsFile(file);
    expect(result.format).toBe("gcode");
    expect(result.unlabeled).toBe(false);
    expect(result.names).toEqual(["a_01", "b_01"]);
  });

  it("parses object names from a .gcode.3mf zip", async () => {
    const zip = new JSZip();
    zip.file(
      "3D/3dmodel.model",
      `<model><resources><object id="1" name="stem_01.stl"/><object id="2" name="stem_02.stl"/></resources></model>`,
    );
    zip.file(
      "Metadata/plate_1.gcode",
      `EXCLUDE_OBJECT_DEFINE NAME=extra_01\n`,
    );
    const blob = await zip.generateAsync({ type: "blob" });
    const file = new File([blob], "job.gcode.3mf", { type: "application/octet-stream" });
    const result = await parseSlicedObjectsFile(file);
    expect(result.format).toBe("3mf");
    expect(result.names).toEqual(["stem_01.stl", "stem_02.stl", "extra_01"]);
  });

  it("marks unlabeled when no object markers exist", async () => {
    const file = new File(["; plain gcode\nG1 X0\n"], "bare.gcode");
    const result = await parseSlicedObjectsFile(file);
    expect(result.unlabeled).toBe(true);
    expect(result.names).toEqual([]);
  });

  it("extracts ASCII markers from bgcode-like binary", async () => {
    const ascii = "EXCLUDE_OBJECT_DEFINE NAME=bin_01\n";
    const bytes = new Uint8Array(64);
    bytes.set([0, 1, 2, 255, 0]);
    bytes.set(new TextEncoder().encode(ascii), 8);
    const chunk = extractAsciiChunks(bytes);
    expect(chunk).toContain("EXCLUDE_OBJECT_DEFINE NAME=bin_01");
    const file = new File([bytes], "job.bgcode");
    const result = await parseSlicedObjectsFile(file);
    expect(result.format).toBe("bgcode");
    expect(result.names).toContain("bin_01");
  });
});

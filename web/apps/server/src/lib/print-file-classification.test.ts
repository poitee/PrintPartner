import { createHash } from "node:crypto";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  classifyPrintFileBytes,
  printFileNextAction,
  printFileRejectionMessage,
  MAX_CLASSIFIABLE_BYTES,
  THREE_MF_ARCHIVE_LIMITS,
} from "./print-file-classification.js";
import { bgcode, hostileZip, MODEL_XML, threeMf } from "../test/print-file-fixtures.js";

describe("3MF classification", () => {
  it("classifies a PrusaSlicer project as a slicer project, never print-ready", () => {
    const result = classifyPrintFileBytes(
      threeMf({
        "[Content_Types].xml": "<Types/>",
        "3D/3dmodel.model": MODEL_XML,
        "Metadata/Slic3r_PE.config": "; prusaslicer_config = begin\nlayer_height = 0.2\n",
        "Metadata/Slic3r_PE_model.config": "<config/>",
        "Metadata/thumbnail.png": "not really a png",
      }),
    );

    expect(result).toMatchObject({
      outcome: "classified",
      classification: { format: "3mf", kind: "slicer_project" },
    });
    if (result.outcome !== "classified") throw new Error("expected a classification");
    expect(printFileNextAction(result.classification)).toContain("needs slicing");
  });

  it("classifies bare geometry as a model package", () => {
    expect(
      classifyPrintFileBytes(
        threeMf({
          "[Content_Types].xml": "<Types/>",
          "3D/3dmodel.model": MODEL_XML,
          "_rels/.rels": "<Relationships/>",
        }),
      ),
    ).toMatchObject({
      outcome: "classified",
      classification: { format: "3mf", kind: "model_package" },
    });
  });

  it("classifies an embedded toolpath as a toolpath package even alongside slicer state", () => {
    expect(
      classifyPrintFileBytes(
        threeMf({
          "[Content_Types].xml": "<Types/>",
          "3D/3dmodel.model": MODEL_XML,
          "Metadata/project_settings.config": "{}",
          "Metadata/plate_1.gcode": "G28\nG1 X10 Y10\n",
        }),
      ),
    ).toMatchObject({
      outcome: "classified",
      classification: { format: "3mf", kind: "toolpath_package" },
    });
  });

  it("classifies a container with no interpretable model as unsupported", () => {
    const result = classifyPrintFileBytes(
      threeMf({ "[Content_Types].xml": "<Types/>", "notes/readme.txt": "hello" }),
    );

    expect(result).toMatchObject({
      outcome: "classified",
      classification: { format: "3mf", kind: "unsupported" },
    });
    if (result.outcome !== "classified") throw new Error("expected a classification");
    expect(printFileNextAction(result.classification)).toContain("cannot interpret");
  });
});

describe("3MF archive limits", () => {
  it("rejects a declared entry count past the cap without walking it", () => {
    expect(
      classifyPrintFileBytes(
        hostileZip([{ name: "3D/3dmodel.model" }], {
          declaredEntryCount: THREE_MF_ARCHIVE_LIMITS.maxEntries + 1,
        }),
      ),
    ).toEqual({ outcome: "rejected", reason: "archive_entry_limit" });
  });

  it("rejects a zip bomb by per-entry and total uncompressed size", () => {
    expect(
      classifyPrintFileBytes(
        hostileZip([
          {
            name: "3D/3dmodel.model",
            uncompressedSize: THREE_MF_ARCHIVE_LIMITS.maxEntryUncompressedBytes + 1,
          },
        ]),
      ),
    ).toEqual({ outcome: "rejected", reason: "archive_entry_too_large" });

    const perEntry = THREE_MF_ARCHIVE_LIMITS.maxEntryUncompressedBytes;
    const entries = Array.from(
      { length: Math.floor(THREE_MF_ARCHIVE_LIMITS.maxTotalUncompressedBytes / perEntry) + 1 },
      (_unused, index) => ({ name: `3D/part-${index}.model`, uncompressedSize: perEntry }),
    );
    expect(classifyPrintFileBytes(hostileZip(entries))).toEqual({
      outcome: "rejected",
      reason: "archive_total_too_large",
    });
  });

  it("rejects traversal, absolute, and backslash entry names", () => {
    for (const name of [
      "../../etc/passwd",
      "3D/../../escape.model",
      "/absolute/3dmodel.model",
      "C:/windows/3dmodel.model",
      "3D\\3dmodel.model",
    ]) {
      expect(classifyPrintFileBytes(hostileZip([{ name }]))).toEqual({
        outcome: "rejected",
        reason: "archive_unsafe_entry",
      });
    }
  });

  it("rejects a symbolic-link-like entry", () => {
    // Unix mode S_IFLNK in the high 16 bits of the external attributes.
    expect(
      classifyPrintFileBytes(
        hostileZip([{ name: "3D/3dmodel.model", externalAttributes: 0xa1ff0000 }]),
      ),
    ).toEqual({ outcome: "rejected", reason: "archive_unsafe_entry" });
  });

  it("rejects entries nested past the depth cap", () => {
    const deep = Array.from({ length: THREE_MF_ARCHIVE_LIMITS.maxNestingDepth }, () => "d").join(
      "/",
    );
    expect(classifyPrintFileBytes(hostileZip([{ name: `${deep}/3dmodel.model` }]))).toEqual({
      outcome: "rejected",
      reason: "archive_nesting_limit",
    });
  });

  it("rejects a container whose central directory is missing", () => {
    expect(classifyPrintFileBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toEqual({
      outcome: "rejected",
      reason: "archive_truncated",
    });
  });
});

describe("G-code and binary G-code classification", () => {
  it("classifies ASCII G-code past a long comment header", () => {
    const header = `; generated by a slicer\n${"; thumbnail data\n".repeat(5_000)}`;
    const bytes = strToU8(`${header}G28 ; home\nG1 X10 Y10 E1\n`);

    expect(classifyPrintFileBytes(bytes)).toEqual({
      outcome: "classified",
      classification: { format: "gcode" },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
    });
  });

  it("refuses comment-only text and binary noise that no printer could run", () => {
    expect(classifyPrintFileBytes(strToU8("; only comments\n; nothing to run\n"))).toEqual({
      outcome: "rejected",
      reason: "unrecognized_signature",
    });
    expect(classifyPrintFileBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({
      outcome: "rejected",
      reason: "unrecognized_signature",
    });
  });

  it("validates the binary G-code header and its block chain", () => {
    expect(classifyPrintFileBytes(bgcode([{ payload: 16 }, { payload: 4 }]))).toMatchObject({
      outcome: "classified",
      classification: { format: "bgcode" },
    });

    const truncated = bgcode([{ payload: 16 }]).slice(0, 20);
    expect(classifyPrintFileBytes(truncated)).toEqual({
      outcome: "rejected",
      reason: "bgcode_header_invalid",
    });

    const badVersion = bgcode([{ payload: 4 }]);
    new DataView(badVersion.buffer).setUint32(4, 99, true);
    expect(classifyPrintFileBytes(badVersion)).toEqual({
      outcome: "rejected",
      reason: "bgcode_header_invalid",
    });

    const headerOnly = bgcode([]);
    expect(classifyPrintFileBytes(headerOnly)).toEqual({
      outcome: "rejected",
      reason: "bgcode_header_invalid",
    });
  });

  it("refuses an empty file and reports every rejection in plain words", () => {
    expect(classifyPrintFileBytes(new Uint8Array(0))).toEqual({
      outcome: "rejected",
      reason: "empty_file",
    });
    for (const reason of [
      "empty_file",
      "file_too_large",
      "unrecognized_signature",
      "bgcode_header_invalid",
      "archive_truncated",
      "archive_entry_limit",
      "archive_entry_too_large",
      "archive_total_too_large",
      "archive_nesting_limit",
      "archive_unsafe_entry",
    ] as const) {
      expect(printFileRejectionMessage(reason)).not.toBe("");
    }
    expect(MAX_CLASSIFIABLE_BYTES).toBeGreaterThan(0);
  });
});

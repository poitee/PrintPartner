import AdmZip from "adm-zip";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  MAX_KIT_JSON_BYTES,
  parseKitBundleBuffer,
} from "./export-kit.js";

function kitJsonBytes(totalBytes: number): Buffer {
  const prefix = Buffer.from(
    '{"format":"print-partner-kit","version":3,"padding":"',
  );
  const suffix = Buffer.from('"}');
  const paddingBytes = totalBytes - prefix.length - suffix.length;
  if (paddingBytes < 0) throw new Error("Requested kit fixture is too small");
  return Buffer.concat([prefix, Buffer.alloc(paddingBytes, 0x61), suffix]);
}

function overwriteDeclaredSize(archive: Buffer, size: number): Buffer {
  const forged = Buffer.from(archive);
  const localHeader = forged.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const centralHeader = forged.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x01, 0x02]),
  );
  if (localHeader < 0 || centralHeader < 0) {
    throw new Error("ZIP fixture is missing its entry headers");
  }
  forged.writeUInt32LE(size, localHeader + 22);
  forged.writeUInt32LE(size, centralHeader + 24);
  return forged;
}

describe("kit bundle payload boundaries", () => {
  it("rejects raw kit.json above the expanded payload limit", () => {
    const payload = kitJsonBytes(MAX_KIT_JSON_BYTES + 1);

    expect(() => parseKitBundleBuffer(payload, "kit.json")).toThrow(/16 MiB/);
  });

  it("rejects an oversized declared ZIP entry before inflation", () => {
    const archive = Buffer.from(
      zipSync({ "kit.json": kitJsonBytes(128) }, { level: 9 }),
    );
    const forged = overwriteDeclaredSize(archive, MAX_KIT_JSON_BYTES + 1);
    const declared = new AdmZip(forged).getEntry("kit.json")?.header.size;
    expect(declared).toBe(MAX_KIT_JSON_BYTES + 1);

    expect(() =>
      parseKitBundleBuffer(forged, "bundle.print-partner-kit.zip"),
    ).toThrow(/16 MiB/);
  });

  it("verifies inflated bytes when a stored entry understates its size", () => {
    const payload = kitJsonBytes(MAX_KIT_JSON_BYTES + 1);
    const archive = Buffer.from(zipSync({ "kit.json": payload }, { level: 0 }));
    const forged = overwriteDeclaredSize(archive, 128);
    const entry = new AdmZip(forged).getEntry("kit.json");
    expect(entry?.header.method).toBe(0);
    expect(entry?.header.size).toBe(128);

    expect(() =>
      parseKitBundleBuffer(forged, "bundle.print-partner-kit.zip"),
    ).toThrow(/16 MiB/);
  });
});

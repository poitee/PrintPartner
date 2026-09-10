import { describe, expect, it } from "vitest";
import { isSharePublisherUrl, referenceShareSchema } from "./reference-sharing.js";

const collection = {
  format: "printpartner-reference-share", version: 1, kind: "collection", title: "Milo sources",
  sources: [{ key: "source-1", name: "Milo", location: { kind: "manual" },
    revision: { branch: null, tag: null, commit: null }, file_rules: ["STL Files/**"] }],
};

describe("reference sharing boundary", () => {
  it("accepts a references-only collection", () => {
    expect(referenceShareSchema.safeParse(collection).success).toBe(true);
  });
  it.each(["models", "files", "credentials", "print_progress", "thumbnail", "gcode"])("rejects the extra field %s", (key) => {
    expect(referenceShareSchema.safeParse({ ...collection, [key]: "embedded payload" }).success).toBe(false);
  });
  it("rejects embedded fields inside a Source and duplicate keys", () => {
    expect(referenceShareSchema.safeParse({ ...collection, sources: [{ ...collection.sources[0], bytes: "model" }] }).success).toBe(false);
    expect(referenceShareSchema.safeParse({ ...collection, sources: [...collection.sources, ...collection.sources] }).success).toBe(false);
  });
  it.each(["../part.stl", "/home/me/part.stl", "C:\\private\\part.stl", "parts/../../part.stl"])("rejects unsafe path %s", (path) => {
    expect(referenceShareSchema.safeParse({ ...collection, sources: [{ ...collection.sources[0], file_rules: [path] }] }).success).toBe(false);
  });
  it("rejects unsupported versions and dangling references", () => {
    expect(referenceShareSchema.safeParse({ ...collection, version: 2 }).success).toBe(false);
    expect(referenceShareSchema.safeParse({ ...collection, kind: "build", layers: [{ source: "source-2", role: "base" }],
      parts: [], selections: {}, include: [], exclude: [], replacements: {} }).success).toBe(false);
  });
  it.each([
    "http://192.168.1.1/models", "file:///private/model", "https://user:secret@github.com/a/b",
    "https://github.com/a/b?token=secret", "https://github.com/a/b#secret", "https://github.com.evil.test/a",
    "https://localhost/a", "https://github.com:443/a", "https://github.com/a\nb",
  ])("does not share an unsafe or unsupported URL: %s", (url) => {
    expect(isSharePublisherUrl(url)).toBe(false);
  });
  it("accepts original publisher links", () => {
    expect(isSharePublisherUrl("https://github.com/MillenniumMachines/Milo-V2.0")).toBe(true);
    expect(isSharePublisherUrl("https://www.printables.com/model/123-example")).toBe(true);
  });
  it("accepts mixed-case HTTPS schemes and publisher hosts", () => {
    expect(isSharePublisherUrl("https://GitHub.com/owner/repository")).toBe(true);
    expect(isSharePublisherUrl("HTTPS://WWW.PRINTABLES.COM/model/123-example")).toBe(true);
    expect(isSharePublisherUrl("HTTPS://GitHub.com.evil.test/owner/repository")).toBe(false);
  });
});

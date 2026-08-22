import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(path));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      files.push(path);
    }
  }
  return files;
}

function productionCallers(symbol: string, owner: string): string[] {
  const pattern = new RegExp(`\\b${symbol}\\b`);
  return productionTypeScriptFiles(sourceRoot)
    .map((path) => ({
      path,
      relativePath: relative(sourceRoot, path).split(sep).join("/"),
    }))
    .filter((file) => file.relativePath !== owner && pattern.test(readFileSync(file.path, "utf8")))
    .map((file) => file.relativePath)
    .sort();
}

describe("known accepted Part browser media caller inventory", () => {
  it("pins accepted basis caches and keeps Source previews on their existing path", () => {
    expect({
      partMeshUrl: productionCallers("partMeshUrl", "api/engine.ts"),
      partThumbnailUrl: productionCallers("partThumbnailUrl", "api/engine.ts"),
      partPreviewUrl: productionCallers("partPreviewUrl", "api/engine.ts"),
      uploadPartThumbnail: productionCallers("uploadPartThumbnail", "api/engine.ts"),
      acceptedPartMediaMetadata: productionCallers(
        "acceptedPartMediaMetadata",
        "api/engine.ts",
      ),
      acceptedPartMediaRevalidationHeaders: productionCallers(
        "acceptedPartMediaRevalidationHeaders",
        "api/engine.ts",
      ),
      getCachedMeshBuffer: productionCallers("getCachedMeshBuffer", "lib/meshCache.ts"),
      cacheMeshBuffer: productionCallers("cacheMeshBuffer", "lib/meshCache.ts"),
      sourceStlMeshUrl: productionCallers("sourceStlMeshUrl", "api/engine.ts"),
      sourceStlPreviewUrl: productionCallers("sourceStlPreviewUrl", "api/engine.ts"),
    }).toEqual({
      partMeshUrl: ["components/Preview3D.tsx", "lib/stlThumbnail.ts"],
      partThumbnailUrl: ["components/parts/PartThumb.tsx"],
      partPreviewUrl: ["components/Preview3D.tsx"],
      uploadPartThumbnail: ["components/Preview3D.tsx", "lib/stlThumbnail.ts"],
      acceptedPartMediaMetadata: [
        "components/Preview3D.tsx",
        "components/parts/PartThumb.tsx",
        "lib/stlThumbnail.ts",
      ],
      acceptedPartMediaRevalidationHeaders: [
        "components/parts/PartThumb.tsx",
        "lib/stlThumbnail.ts",
      ],
      getCachedMeshBuffer: ["lib/stlThumbnail.ts"],
      cacheMeshBuffer: ["lib/stlThumbnail.ts"],
      sourceStlMeshUrl: ["components/Preview3D.tsx"],
      sourceStlPreviewUrl: ["components/Preview3D.tsx"],
    });
  });
});

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
      partMeshUrl: productionCallers("partMeshUrl", "api/endpoints/media.ts"),
      partThumbnailUrl: productionCallers("partThumbnailUrl", "api/endpoints/media.ts"),
      partPreviewUrl: productionCallers("partPreviewUrl", "api/endpoints/media.ts"),
      uploadPartThumbnail: productionCallers("uploadPartThumbnail", "api/endpoints/media.ts"),
      acceptedPartMediaMetadata: productionCallers(
        "acceptedPartMediaMetadata",
        "api/endpoints/media.ts",
      ),
      acceptedPartMediaRevalidationHeaders: productionCallers(
        "acceptedPartMediaRevalidationHeaders",
        "api/endpoints/media.ts",
      ),
      getCachedMeshBuffer: productionCallers("getCachedMeshBuffer", "lib/meshCache.ts"),
      cacheMeshBuffer: productionCallers("cacheMeshBuffer", "lib/meshCache.ts"),
      sourceStlMeshUrl: productionCallers("sourceStlMeshUrl", "api/endpoints/media.ts"),
      sourceStlPreviewUrl: productionCallers("sourceStlPreviewUrl", "api/endpoints/media.ts"),
    }).toEqual({
      partMeshUrl: [
        "api/engine.ts",
        "components/Preview3D.tsx",
        "components/export/accepted-plates/AcceptedPlate3DPreview.tsx",
        "lib/stlThumbnail.ts",
      ],
      partThumbnailUrl: ["api/engine.ts", "components/parts/PartThumb.tsx"],
      partPreviewUrl: ["api/engine.ts", "components/Preview3D.tsx"],
      uploadPartThumbnail: ["api/engine.ts", "components/Preview3D.tsx", "lib/stlThumbnail.ts"],
      acceptedPartMediaMetadata: [
        "api/engine.ts",
        "components/Preview3D.tsx",
        "components/parts/PartThumb.tsx",
        "lib/stlThumbnail.ts",
      ],
      acceptedPartMediaRevalidationHeaders: [
        "api/engine.ts",
        "components/parts/PartThumb.tsx",
        "lib/stlThumbnail.ts",
      ],
      getCachedMeshBuffer: ["lib/stlThumbnail.ts"],
      cacheMeshBuffer: ["lib/stlThumbnail.ts"],
      sourceStlMeshUrl: ["api/engine.ts", "components/Preview3D.tsx"],
      sourceStlPreviewUrl: ["api/engine.ts", "components/Preview3D.tsx"],
    });
  });
});

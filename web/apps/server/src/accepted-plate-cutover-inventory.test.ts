import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      files.push(path);
    }
  }
  return files;
}

const webRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverRoot = join(webRoot, "apps/server/src");

function callers(root: string, symbol: string) {
  const pattern = new RegExp(`\\.${symbol}\\(`, "g");
  return productionTypeScriptFiles(root)
    .map((path) => ({
      file: relative(serverRoot, path).split(sep).join("/"),
      count: readFileSync(path, "utf8").match(pattern)?.length ?? 0,
    }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => left.file.localeCompare(right.file));
}

describe("accepted Plate server cutover inventory", () => {
  it("has no production legacy Plate symbol or setting callers", () => {
    const roots = [
      serverRoot,
      join(webRoot, "apps/web/src"),
      join(webRoot, "packages/contracts/src"),
      join(webRoot, "packages/domain/src"),
    ];
    const source = roots.flatMap(productionTypeScriptFiles)
      .filter((path) => !path.endsWith("db/legacy-print-plan-removal.ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const legacy of [
      "runExport3mfJob",
      "runAutoSliceJob",
      "runPackPreviewJob",
      "loadKitPrintPlan",
      "saveKitPrintPlan",
      "buildPlateWorkspace",
      "objectDisplayName",
      "KitPlateLayout",
      "print_plan:",
    ]) {
      expect(source.includes(legacy), legacy).toBe(false);
    }
  });

  it("has no retained operational export compatibility projection callers", () => {
    expect(callers(serverRoot, "buildMergePartsForProfile")).toEqual([]);
    expect(callers(serverRoot, "printUnitsByPartId")).toEqual([]);
  });

  it("keeps browser, assistant, and MCP production code off removed interfaces", () => {
    const roots = [join(webRoot, "apps/web/src"), join(serverRoot, "assistant"), join(serverRoot, "mcp")];
    const source = roots.flatMap(productionTypeScriptFiles).map((path) => readFileSync(path, "utf8")).join("\n");
    for (const legacy of [
      "/print-plan",
      "/print-groups",
      "/print-assignments",
      "/plate-workspace",
      "/jobs/export-3mf",
      "/jobs/pack-preview",
      "/jobs/auto-slice",
      "/open-plates",
    ]) {
      expect(source.includes(legacy), legacy).toBe(false);
    }
  });
});

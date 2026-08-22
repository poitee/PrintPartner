import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../../../", import.meta.url));

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

function productionMatches(pattern: RegExp): string[] {
  return [
    join(webRoot, "apps/server/src"),
    join(webRoot, "apps/web/src"),
    join(webRoot, "packages/contracts/src"),
  ]
    .flatMap(productionTypeScriptFiles)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(webRoot, path).split(sep).join("/"))
    .sort();
}

describe("Plan draft cutover production inventory", () => {
  it("keeps legacy recompute and direct manifest Apply symbols deleted", () => {
    for (const pattern of [
      /\brecomputeProfile\b/,
      /\bapplyManifestToProfile\b/,
      /\bstartRecompute\b/,
      /\brunRecompute\b/,
      /\/jobs\/recompute/,
      /\/plans\/:id\/apply-manifest/,
    ]) {
      expect(productionMatches(pattern)).toEqual([]);
    }

    const contracts = readFileSync(join(webRoot, "packages/contracts/src/index.ts"), "utf8");
    const jobKinds = contracts.slice(
      contracts.indexOf("export const JOB_KINDS"),
      contracts.indexOf("export type JobKind"),
    );
    expect(jobKinds).not.toContain('"recompute"');
  });

  it("retains only filament and spool fields on the generic Part patch", () => {
    const routes = readFileSync(join(webRoot, "apps/server/src/routes/parts.ts"), "utf8");
    const route = routes.slice(
      routes.indexOf('app.patch("/parts/:id"'),
      routes.indexOf('app.patch("/parts/:id/progress"'),
    );
    expect(route).toContain('key !== "filament_color_id" && key !== "spoolman_spool_id"');
    expect(route).not.toMatch(/\b(included|quantity_override)\b/);

    const repository = readFileSync(join(webRoot, "apps/server/src/db/repository.ts"), "utf8");
    expect(repository).not.toContain("  patchPart(");
    expect(repository).toContain("  assignAcceptedFilament(");
    expect(repository).not.toContain("  bulkSetRoleFilament(");
  });

  it("keeps Progress and assembly on accepted token commands", () => {
    const repository = readFileSync(join(webRoot, "apps/server/src/db/repository.ts"), "utf8");
    expect(repository).toContain("  setAcceptedUnitCompletion(");
    expect(repository).toContain("  setAcceptedUnitAssembly(");
    expect(repository).not.toContain("  patchPartProgress(");
    expect(repository).not.toContain("  patchPartAssembled(");

    const routes = readFileSync(join(webRoot, "apps/server/src/routes/parts.ts"), "utf8");
    expect(routes).toContain("setAcceptedUnitCompletion");
    expect(routes).toContain("setAcceptedUnitAssembly");
  });

  it("creates compatibility Parts only through applyPlanChanges", () => {
    const repository = readFileSync(join(webRoot, "apps/server/src/db/repository.ts"), "utf8");
    expect(repository.split(".insert(this.schema.parts)").length - 1).toBe(1);
    expect(repository).toContain("applyPlanChanges(");
  });
});

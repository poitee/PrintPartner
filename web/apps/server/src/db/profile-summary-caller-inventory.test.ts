import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function knownProductionCallers(
  symbol: string,
  owner: string,
): Array<{ readonly file: string; readonly count: number }> {
  const pattern = new RegExp(`\\b${symbol}\\b`);
  return productionTypeScriptFiles(sourceRoot)
    .map((path) => ({ path, relativePath: relative(sourceRoot, path).split(sep).join("/") }))
    .filter((file) => file.relativePath !== owner && pattern.test(readFileSync(file.path, "utf8")))
    .map((file) => ({
      file: file.relativePath,
      count: readFileSync(file.path, "utf8").match(new RegExp(`\\b${symbol}\\b`, "g"))?.length ?? 0,
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

describe("Profile summary caller inventory", () => {
  it("pins summary and header API consumers", () => {
    expect(knownProductionCallers("getProfile", "db/repository.ts")).toEqual([]);
    expect(knownProductionCallers("listProfiles", "db/repository.ts")).toEqual([]);
    expect(knownProductionCallers("printUnitTotals", "db/repository.ts")).toEqual([]);
    expect(knownProductionCallers("listAcceptedProfileSummaries", "db/repository.ts")).toEqual([
      { file: "assistant/tools.ts", count: 1 },
      { file: "routes/discord-digest.ts", count: 1 },
      { file: "routes/metrics.ts", count: 1 },
      { file: "routes/plans.ts", count: 1 },
    ]);
    expect(knownProductionCallers("readAcceptedProfileSummary", "db/repository.ts")).toEqual([
      { file: "routes/plans.ts", count: 4 },
    ]);
    expect(knownProductionCallers("getProfileHeader", "db/repository.ts")).toEqual([
      { file: "assistant/assistant-context.ts", count: 1 },
      { file: "assistant/tools.ts", count: 1 },
    ]);
    expect(knownProductionCallers("listProfileHeaders", "db/repository.ts")).toEqual([
      { file: "assistant/example-builds.ts", count: 1 },
      { file: "assistant/tools.ts", count: 1 },
      { file: "routes/printer-checkoff.ts", count: 1 },
      { file: "services/knowledge-bundle.ts", count: 1 },
    ]);
    const digestCapture = readFileSync(
      join(sourceRoot, "../capture-digest-fixtures.ts"),
      "utf8",
    );
    expect(
      digestCapture.match(/\binvokeAssistantTool\(\s*"get_print_stats"/g) ?? [],
    ).toHaveLength(1);
  });

  it("keeps deleted summary APIs out and confines the legacy v1 type to its presenter", () => {
    const repository = readFileSync(join(sourceRoot, "db/repository.ts"), "utf8");
    expect(repository.match(/\b(getProfile|listProfiles|printUnitTotals)\b/g) ?? []).toEqual([]);

    const presenter = readFileSync(join(sourceRoot, "routes/plan-summary-presenter.ts"), "utf8");
    expect(presenter.match(/\bLegacyProfileSummaryV1\b/g) ?? []).toHaveLength(2);
    expect(knownProductionCallers("LegacyProfileSummaryV1", "routes/plan-summary-presenter.ts")).toEqual([]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("removed Copilot UI bridge", () => {
  it("does not leave unreachable Copilot UI modules, imports, or comments", () => {
    const sourceRoot = join(process.cwd(), "src");
    const thisFile = join(sourceRoot, "lib", "deadCopilotUi.test.ts");
    const residue = sourceFiles(sourceRoot)
      .filter((path) => path !== thisFile)
      .flatMap((path) => {
        const content = readFileSync(path, "utf8");
        const matches = [
          ...content.matchAll(/CopilotUi|Copilot:|copilot deep-link|from copilot/gi),
        ];
        return matches.map((match) => `${path}:${match.index}:${match[0]}`);
      });

    expect(residue).toEqual([]);
  });
});

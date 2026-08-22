import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * GRE-233 / GRE-215: Progress Print sheet pagination + screen chrome.
 * Contract is encoded in App.css so a large first repo cannot push part rows
 * off page 1 (title + tally alone).
 */
const cssPath = join(dirname(fileURLToPath(import.meta.url)), "../App.css");
const css = readFileSync(cssPath, "utf8");

function mediaBlock(source: string, query: "print" | "screen"): string {
  const re = new RegExp(`@media\\s+${query}\\s*\\{`);
  const match = re.exec(source);
  expect(match, `missing @media ${query} block`).toBeTruthy();
  const brace = source.indexOf("{", match!.index);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  throw new Error(`unclosed @media ${query} block`);
}

const printCss = mediaBlock(css, "print");
const screenCss = mediaBlock(css, "screen");

describe("checkoff print CSS (GRE-233)", () => {
  it("does not break-inside-avoid a whole repo or folder on print", () => {
    expect(printCss).not.toMatch(
      /\.sheet-repo\s*\{[^}]*break-inside:\s*avoid(?:-page)?/s,
    );
    expect(printCss).not.toMatch(
      /\.sheet-folder\s*\{[^}]*break-inside:\s*avoid(?:-page)?/s,
    );
    expect(printCss).toMatch(/\.sheet-repo\s*\{[^}]*break-inside:\s*auto/s);
    expect(printCss).toMatch(/\.sheet-folder\s*\{[^}]*break-inside:\s*auto/s);
  });

  it("avoids breaking only a single part row", () => {
    expect(printCss).toMatch(/\.sheet-table tr\s*\{[^}]*break-inside:\s*avoid/s);
    // Continuous layout must not undo part-row keep-together (GRE-233 lock).
    expect(printCss).not.toMatch(
      /\.checkoff-sheet-print-continuous[\s\S]*?\.sheet-table tr\s*\{[^}]*break-inside:\s*auto/s,
    );
  });

  it("keeps title + tally with following sheet body", () => {
    expect(printCss).toMatch(/\.sheet-header\s*\{[^}]*break-after:\s*avoid/s);
  });

  it("hides Progress print-only sheet on screen", () => {
    expect(screenCss).toMatch(
      /\.checkoff-sheet-print-only:not\(\.is-print-prep\)\s*\{[^}]*display:\s*none\s*!important/s,
    );
  });

  it("remaps checkoff sheet to dark card tokens on screen only", () => {
    expect(screenCss).toMatch(/\.dark\s+\.checkoff-sheet\s*\{[^}]*--paper-bg:\s*var\(--card\)/s);
    expect(screenCss).toMatch(/\.dark\s+\.checkoff-sheet\s*\{[^}]*--paper-fg:\s*var\(--foreground\)/s);
    expect(printCss).toMatch(/\.checkoff-sheet\s*\{[^}]*--paper-bg:\s*#ffffff/s);
  });
});

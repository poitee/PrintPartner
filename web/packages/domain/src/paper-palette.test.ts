import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAPER, PAPER_CSS_VARIABLES } from "./paper-palette.js";

const indexCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/src/index.css"),
  "utf8",
);

describe("paper palette", () => {
  it.each(Object.entries(PAPER_CSS_VARIABLES))(
    "matches %s in index.css",
    (key, cssVariable) => {
      const match = new RegExp(`${cssVariable}:\\s*(#[0-9a-f]{3,8})\\s*;`).exec(indexCss);
      expect(match, `index.css does not define ${cssVariable}`).toBeTruthy();
      expect(match![1]).toBe(PAPER[key as keyof typeof PAPER]);
    },
  );

  it("stays theme-independent", () => {
    // The whole point: a printed sheet must not follow the app's chrome. If a
    // paper value ever became a var(), the server export could not resolve it.
    for (const value of Object.values(PAPER)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

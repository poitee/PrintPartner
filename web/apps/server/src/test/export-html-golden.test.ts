import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checklistFixtureNames,
  exportHtmlFixtureRoot,
  readChecklistFixture,
  renderChecklistFixture,
} from "./export-html-golden.js";

const names = checklistFixtureNames();

describe("HTML checklist parity goldens", () => {
  it("has exactly the three required plans and matching expected HTML files", () => {
    expect(names).toEqual([
      "checkoff-partly-done.json",
      "multi-layer-addons.json",
      "single-layer.json",
    ]);
    expect(
      readdirSync(join(exportHtmlFixtureRoot, "expected"))
        .filter((name) => name.endsWith(".html"))
        .sort(),
    ).toEqual(names.map((name) => name.replace(/\.json$/, ".html")));
  });

  for (const name of names) {
    it(`matches committed HTML for ${name}`, () => {
      const fixture = readChecklistFixture(name);
      const rendered = renderChecklistFixture(fixture);
      const expected = readFileSync(
        join(exportHtmlFixtureRoot, "expected", name.replace(/\.json$/, ".html")),
        "utf8",
      ).replace(/\r\n/g, "\n");
      expect(rendered.html).toBe(expected);
      expect(rendered.partCount).toBe(fixture.parts.filter((part) => part.included).length);
      expect(rendered.thumbCount).toBe(0);
    });
  }

  it("ignores volatile timestamps and identities while preserving visible changes", () => {
    const fixture = readChecklistFixture("checkoff-partly-done.json");
    const baseline = renderChecklistFixture(fixture).html;
    expect(
      renderChecklistFixture({
        ...fixture,
        generatedAt: "2099-12-31T23:59:59.000Z",
        profile: { ...fixture.profile, id: 999 },
        parts: fixture.parts.map((part) => ({
          ...part,
          revisionPartId: 999,
          projectionPartId: 888,
          units: part.units.map((unit) => ({ ...unit, token: "volatile" })),
        })),
      }).html,
    ).toBe(baseline);
    expect(
      renderChecklistFixture({
        ...fixture,
        parts: fixture.parts.map((part) => ({
          ...part,
          units: part.units.map((unit) => ({ ...unit, completed: false })),
        })),
      }).html,
    ).not.toBe(baseline);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixtureDirectory = new URL(
  "../../../../../../fixtures/integrations/home-assistant/",
  import.meta.url,
);
const fixtureNames = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe(`Home Assistant JSON fixtures (${fixtureNames.length} fixtures)`, () => {
  it("contains fixtures", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)("parses %s", (name) => {
    const payload: unknown = JSON.parse(
      readFileSync(new URL(name, fixtureDirectory), "utf8"),
    );
    expect(payload).toBeTypeOf("object");
    expect(payload).not.toBeNull();
    expect(Array.isArray(payload)).toBe(false);
  });
});

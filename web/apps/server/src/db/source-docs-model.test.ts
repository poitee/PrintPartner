import { describe, expect, it } from "vitest";
import { docTitleFromPath } from "./source-docs-model.js";

describe("docTitleFromPath", () => {
  it("labels readme files as README", () => {
    expect(docTitleFromPath("README.md")).toBe("README");
    expect(docTitleFromPath("docs/readme.md")).toBe("README");
  });

  it("uses the basename for other documents", () => {
    expect(docTitleFromPath("docs/build-guide.md")).toBe("build-guide.md");
  });
});

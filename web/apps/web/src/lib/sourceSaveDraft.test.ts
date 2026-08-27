import { describe, expect, it } from "vitest";
import { sourceSavePayloadFromDraft, type SourceSaveDraft } from "./sourceSaveDraft";

const draft: SourceSaveDraft = {
  name: " Example ",
  url: " https://github.com/example/repo ",
  refType: "branch",
  branch: " main ",
  tag: "",
  source_kind: "github",
  category: " Printers ",
};

describe("sourceSavePayloadFromDraft", () => {
  it("normalizes Source save fields", () => {
    expect(sourceSavePayloadFromDraft(draft)).toEqual({
      name: "Example",
      url: "https://github.com/example/repo",
      branch: "main",
      tag: null,
      source_kind: "github",
      category: "Printers",
    });
  });

  it("requires GitHub tag values when tag mode is selected", () => {
    expect(() =>
      sourceSavePayloadFromDraft({ ...draft, refType: "tag", tag: "" }),
    ).toThrow("Enter a tag or switch back to Branch.");
  });

  it("requires model page URLs for storefront Sources", () => {
    expect(() =>
      sourceSavePayloadFromDraft({ ...draft, source_kind: "printables", url: "" }),
    ).toThrow("Enter the model page URL from Printables or MakerWorld.");
  });
});

import { describe, expect, it } from "vitest";
import { parsePersistedReviewPartsUi } from "./persistedReviewPartsUi";

describe("parsePersistedReviewPartsUi", () => {
  it("returns defaults for invalid JSON", () => {
    const ui = parsePersistedReviewPartsUi("not-json");
    expect(ui.viewMode).toBe("edit");
    expect(ui.includedFilter).toBe("included");
  });

  it("parses stored filters", () => {
    const ui = parsePersistedReviewPartsUi(
      JSON.stringify({
        search: "bracket",
        printFilter: "partial",
        viewMode: "print",
        compactMode: true,
        groupMode: "source",
        layoutMode: "table",
      }),
    );
    expect(ui.search).toBe("bracket");
    expect(ui.printFilter).toBe("partial");
    expect(ui.viewMode).toBe("print");
    expect(ui.compactMode).toBe(true);
    expect(ui.groupMode).toBe("source");
    expect(ui.layoutMode).toBe("table");
  });

  it("defaults group/layout modes for legacy stored UI", () => {
    const ui = parsePersistedReviewPartsUi(JSON.stringify({ search: "x" }));
    expect(ui.groupMode).toBe("role");
    expect(ui.layoutMode).toBe("grid");
  });
});

import { describe, expect, it } from "vitest";
import {
  parsePersistedSourcesUi,
  serializePersistedSourcesUi,
  SOURCES_UI_STORAGE_KEY,
} from "./persistedSourcesUi";

describe("persistedSourcesUi", () => {
  it("returns defaults for empty input", () => {
    expect(parsePersistedSourcesUi(null)).toEqual({
      viewMode: "grid",
      categoryFilter: "all",
      syncFilter: "all",
      platformFilter: "all",
      search: "",
    });
  });

  it("round-trips valid state", () => {
    const state = {
      viewMode: "list" as const,
      categoryFilter: "Mods",
      syncFilter: "synced" as const,
      platformFilter: "github",
      search: "voron",
    };
    const raw = serializePersistedSourcesUi(state);
    expect(parsePersistedSourcesUi(raw)).toEqual(state);
  });

  it("ignores invalid fields", () => {
    const parsed = parsePersistedSourcesUi(
      JSON.stringify({
        viewMode: "table",
        syncFilter: "maybe",
        categoryFilter: 42,
      }),
    );
    expect(parsed.viewMode).toBe("grid");
    expect(parsed.syncFilter).toBe("all");
    expect(parsed.categoryFilter).toBe("all");
  });

  it("uses stable storage key", () => {
    expect(SOURCES_UI_STORAGE_KEY).toBe("print-partner.sources.ui.v1");
  });
});

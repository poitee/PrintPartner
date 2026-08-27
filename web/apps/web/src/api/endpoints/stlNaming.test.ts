import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import { DEFAULT_STL_NAMING_PROFILE } from "@print-partner/contracts";
import {
  DEFAULT_QUANTITY_REGEX,
  fetchStlNaming,
  mergeStlNamingProfiles,
  previewStlNaming,
  saveStlNaming,
} from "./stlNaming";

const http = createEndpointTestHttp();

describe("STL naming endpoints", () => {
  it("exports the default quantity regex and merges profile overrides", () => {
    expect(DEFAULT_QUANTITY_REGEX).toBe(
      DEFAULT_STL_NAMING_PROFILE.quantity.regex,
    );
    const merged = mergeStlNamingProfiles(DEFAULT_STL_NAMING_PROFILE, {
      roles: [{ id: "accent", label: "Accent", markers: ["accent"] }],
      quantity: { regex: "x(\\d+)" },
    });

    expect(
      merged.roles.some(
        (role) => role.id === "accent" && role.label === "Accent",
      ),
    ).toBe(true);
    expect(merged.quantity.regex).toBe("x(\\d+)");
  });

  it("fetches, saves, and previews STL naming", async () => {
    http
      .respond(jsonResponse({ profile: DEFAULT_STL_NAMING_PROFILE }))
      .respond(jsonResponse({ profile: DEFAULT_STL_NAMING_PROFILE }))
      .respond(jsonResponse({ role: "part", quantity: 2, part_slug: "gear" }));

    await fetchStlNaming();
    await saveStlNaming(DEFAULT_STL_NAMING_PROFILE);
    await previewStlNaming({
      relative_path: "gear_x2.stl",
      profile: DEFAULT_STL_NAMING_PROFILE,
    });

    expect(http.calls[0]?.[0]).toContain("/settings/stl-naming");
    expect(http.requestJson(1)).toEqual({
      profile: DEFAULT_STL_NAMING_PROFILE,
    });
    expect(http.requestJson(2)).toEqual({
      relative_path: "gear_x2.stl",
      profile: DEFAULT_STL_NAMING_PROFILE,
    });
  });
});

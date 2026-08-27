import { DEFAULT_NAMING_PROFILE } from "@print-partner/domain";
import { describe, expect, it } from "vitest";
import { sourceNamingResponse } from "./source-naming-model.js";

const effective = DEFAULT_NAMING_PROFILE;

describe("sourceNamingResponse", () => {
  it("hides overrides when the source uses defaults", () => {
    expect(
      sourceNamingResponse({
        useDefaults: true,
        override: { roles: [{ id: "primary", markers: ["custom"] }] },
        effective,
      }),
    ).toMatchObject({
      use_defaults: true,
      override: {},
      effective,
    });
  });

  it("returns the override when defaults are disabled", () => {
    const override = { roles: [{ id: "primary" as const, markers: ["custom"] }] };

    expect(sourceNamingResponse({ useDefaults: false, override, effective })).toMatchObject({
      use_defaults: false,
      override,
      effective,
    });
  });

  it("includes a stable digest of the effective naming profile", () => {
    const first = sourceNamingResponse({ useDefaults: true, override: {}, effective });
    const second = sourceNamingResponse({ useDefaults: true, override: {}, effective });

    expect(first.effective_digest).toHaveLength(64);
    expect(first.effective_digest).toBe(second.effective_digest);
  });
});

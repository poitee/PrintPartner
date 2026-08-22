import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("Vite development API proxy", () => {
  it("proxies every operational backend route prefix used outside the SPA", () => {
    const proxy = config.server?.proxy ?? {};

    expect(Object.keys(proxy)).toEqual(
      expect.arrayContaining([
        "/admin",
        "/api",
        "/assistant",
        "/backups",
        "/exports",
        "/mcp",
        "/metrics",
        "/profile-library",
        "/slicer-profile-options",
      ]),
    );
  });
});

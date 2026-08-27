import type { IncomingMessage } from "node:http";
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

  it("serves the app, not JSON, for SPA routes that share a path with an API", () => {
    const proxy = config.server?.proxy ?? {};

    // `/sources` and `/printers` answer a same-path GET on the API. A browser
    // page load at those paths must reach the SPA; an API fetch must not.
    for (const path of ["/help", "/parts", "/plans", "/printers", "/settings", "/sources"]) {
      const options = proxy[path];
      expect(options, `${path} is not proxied`).toBeDefined();
      const bypass = (options as { bypass?: (req: IncomingMessage) => string | undefined })
        .bypass;
      expect(bypass, `${path} has no SPA bypass`).toBeTypeOf("function");

      const documentLoad = {
        url: path,
        headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
      } as unknown as IncomingMessage;
      expect(bypass!(documentLoad), `${path} document load was proxied`).toBe(path);

      const apiFetch = { url: path, headers: { accept: "*/*" } } as unknown as IncomingMessage;
      expect(bypass!(apiFetch), `${path} API fetch was not proxied`).toBeUndefined();
    }
  });
});

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "../db/repository.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: unknown) {
      if (String(path).endsWith("registry-index.yaml")) return "entries: not-an-array\n";
      return actual.readFileSync(
        path,
        options as Parameters<typeof actual.readFileSync>[1],
      );
    },
  };
});

import { registerManifestRoutes } from "./manifest.js";

describe("manifest registry route errors", () => {
  it("returns an explicit server error for an invalid embedded registry", async () => {
    const app = Fastify();
    await registerManifestRoutes(app, { repo: {} as AppRepository });

    try {
      const response = await app.inject({ method: "GET", url: "/manifest-registry" });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        detail: "Manifest registry is unavailable",
      });
    } finally {
      await app.close();
    }
  });
});

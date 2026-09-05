import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ProfileLibraryRow } from "../db/repository.js";
import { registerProfileLibraryRoutes } from "./profile-library.js";

describe("profile library route", () => {
  it("does not expose flattened slicer settings or host paths", async () => {
    const profile: ProfileLibraryRow = {
      id: 7,
      kind: "printer",
      name: "Workshop printer",
      slicerFormat: "orca_json",
      materialType: null,
      resolvedFlatConfig: JSON.stringify({ print_host: "10.0.0.5", access_code: "secret" }),
      sourcePath: "/home/operator/.config/OrcaSlicer/user/default/machine/private.json",
      syncedFromSlicerVersion: "2.3.0",
      lastSyncedAt: "2026-09-04T12:00:00.000Z",
      importedAt: "2026-09-04T12:00:00.000Z",
    };
    const app = Fastify();
    await registerProfileLibraryRoutes(app, {
      repo: { listProfileLibrary: () => [profile] },
    });

    try {
      const response = await app.inject({ method: "GET", url: "/profile-library" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        profiles: [{
          id: 7,
          kind: "printer",
          name: "Workshop printer",
          slicerFormat: "orca_json",
          materialType: null,
          syncedFromSlicerVersion: "2.3.0",
          lastSyncedAt: "2026-09-04T12:00:00.000Z",
          importedAt: "2026-09-04T12:00:00.000Z",
        }],
      });
      expect(response.body).not.toContain("access_code");
      expect(response.body).not.toContain("/home/operator");
    } finally {
      await app.close();
    }
  });
});

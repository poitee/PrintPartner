import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";

type RouteDeps = { repo: Pick<AppRepository, "listProfileLibrary"> };

/**
 * Read-only slicer profile library — the profiles synced from the slicer config
 * volumes by the profile-sync watcher, plus PP-native starters.
 */
export async function registerProfileLibraryRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/profile-library", async () => {
    return {
      profiles: deps.repo.listProfileLibrary().map((profile) => ({
        id: profile.id,
        kind: profile.kind,
        name: profile.name,
        slicerFormat: profile.slicerFormat,
        materialType: profile.materialType,
        syncedFromSlicerVersion: profile.syncedFromSlicerVersion,
        lastSyncedAt: profile.lastSyncedAt,
        importedAt: profile.importedAt,
      })),
    };
  });
}

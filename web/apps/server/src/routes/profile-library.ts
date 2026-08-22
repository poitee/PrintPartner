import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";

type RouteDeps = { repo: AppRepository };

/**
 * Read-only slicer profile library — the profiles synced from the slicer config
 * volumes by the profile-sync watcher, plus PP-native starters.
 */
export async function registerProfileLibraryRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/profile-library", async () => {
    return { profiles: deps.repo.listProfileLibrary() };
  });
}

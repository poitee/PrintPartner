import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, SqliteDatabase } from "./client.js";
import { AppRepository } from "./repository.js";
import * as schema from "./schema.js";
import { deriveBuildRecipe } from "../services/build-recipe.js";

function withRepos(
  run: (repo: AppRepository, foreignRepo: AppRepository, db: ReturnType<typeof getDb>) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "pp-profile-headers-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  try {
    const db = getDb(sqlite);
    run(
      new AppRepository(db, "default", sqlite.reposDir),
      new AppRepository(db, "foreign", sqlite.reposDir),
      db,
    );
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Profile headers", () => {
  it("preserves metadata, name order, archived rows, and tenant ownership", () => {
    withRepos((repo, foreignRepo, db) => {
      const zeta = repo.createProfile("Zeta");
      const alpha = repo.createProfile("Alpha");
      foreignRepo.createProfile("Foreign");
      db.update(schema.buildProfiles)
        .set({ specialRequest: "   ", archivedAt: "2026-08-21T12:00:00.000Z" })
        .where(eq(schema.buildProfiles.id, zeta.id))
        .run();

      const headers = repo.listProfileHeaders();
      expect(headers.map((header) => header.name)).toEqual(["Alpha", "Zeta"]);
      expect(headers.find((header) => header.id === zeta.id)).toEqual(
        expect.objectContaining({
          special_request: null,
          archived_at: "2026-08-21T12:00:00.000Z",
        }),
      );
      for (const header of headers) {
        expect(repo.getProfileHeader(header.id)).toEqual(header);
      }
      expect(repo.getProfileHeader(999_999)).toBeNull();
      expect(foreignRepo.getProfileHeader(alpha.id)).toBeNull();
    });
  });

  it("does not read Progress when listing or getting headers", () => {
    withRepos((repo, _foreignRepo, db) => {
      const profile = repo.createProfile("Header only");
      db.insert(schema.parts)
        .values({
          tenantId: "default",
          profileId: profile.id,
          matchKey: "part.stl",
          relativePath: "part.stl",
          filename: "part.stl",
          quantityEffective: 3,
          included: true,
        })
        .run();
      expect(repo.getProfileHeader(profile.id)?.part_count).toBe(1);
      expect(repo.listProfileHeaders()).toHaveLength(1);
    });
  });

  it("provides Plan names to the Build recipe service", () => {
    withRepos((repo) => {
      const profile = repo.createProfile("Recipe metadata");

      expect(deriveBuildRecipe(repo, profile.id)?.plan_name).toBe("Recipe metadata");
    });
  });
});

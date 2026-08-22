import { acceptPlanForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptedPlanBasis } from "./db/accepted-plan-progress.js";
import { resolveFilamentAssignment } from "./db/accepted-part-filament.js";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { globalThumbnailPath } from "./lib/thumbnails.js";
import { clearPartThumbnailCacheAtHexes, clearPlanThumbnailCache } from "./services/plan-thumbnails.js";
import {
  canonicalRoleOrder,
  loadRoleFilamentDefaults,
  saveRoleFilamentDefault,
} from "./services/role-filament-store.js";
import { resolvePartFilamentHex } from "./services/filament-catalog.js";
import { resolvePartStl } from "./services/part-paths.js";

describe("clearPlanThumbnailCache", () => {
  it("removes cached PNGs for parts in a plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-thumb-clear-"));
    const thumbsDir = join(dir, "thumbs");
    mkdirSync(thumbsDir, { recursive: true });
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    const source = repo.createSource({ name: "ThumbRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "widget.stl"), "solid widget");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);

    const plan = repo.createProfile("ThumbPlan", source.id);
    acceptPlanForTest(repo, plan.id);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(accepted.snapshot),
        target: { kind: "role", role: "primary" },
        assignment: { color: { kind: "catalog", colorId: "pla-black" }, spoolmanSpoolId: null },
      }).kind,
    ).toBe("updated");

    const part = repo.getProfilePartRows(plan.id)[0]!;
    const stl = resolvePartStl(repo, part)!;
    const hex = resolvePartFilamentHex(part);
    const thumbPath = globalThumbnailPath(thumbsDir, stl, part.role || "primary", hex);
    mkdirSync(join(thumbPath, ".."), { recursive: true });
    writeFileSync(thumbPath, Buffer.from("fake png"));

    const cleared = clearPlanThumbnailCache(repo, thumbsDir, plan.id);
    expect(cleared).toBeGreaterThan(0);

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("clearPartThumbnailCacheAtHexes", () => {
  it("clears both previous and new filament color caches", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-thumb-hexes-"));
    const thumbsDir = join(dir, "thumbs");
    mkdirSync(thumbsDir, { recursive: true });
    const stlPath = join(dir, "widget.stl");
    writeFileSync(stlPath, "solid widget");

    const oldHex = "#c41230";
    const newHex = "#000000";
    const oldThumb = globalThumbnailPath(thumbsDir, stlPath, "primary", oldHex);
    const newThumb = globalThumbnailPath(thumbsDir, stlPath, "primary", newHex);
    mkdirSync(join(oldThumb, ".."), { recursive: true });
    writeFileSync(oldThumb, Buffer.from("old"));
    writeFileSync(newThumb, Buffer.from("new"));

    const cleared = clearPartThumbnailCacheAtHexes(thumbsDir, stlPath, "primary", [
      oldHex,
      newHex,
    ]);
    expect(cleared).toBeGreaterThanOrEqual(2);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("apply-role-colors route logic", () => {
  it("re-applies saved role defaults to matching parts", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-apply-roles-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    const plan = repo.createProfile("ApplyRolesPlan");
    saveRoleFilamentDefault(repo, plan.id, "accent", {
      filament_color_id: null,
      filament_custom_hex: "#ff6600",
      spoolman_spool_id: null,
    });

    const source = repo.createSource({ name: "AccentRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "[a]_bracket.stl"), "solid accent");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);
    repo.setBaseLayer(plan.id, source.id);
    acceptPlanForTest(repo, plan.id);

    const part = repo.listParts(plan.id).parts.find((p) => p.role === "accent")!;
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const expected = acceptedPlanBasis(accepted.snapshot);
    expect(
      repo.assignAcceptedFilament({
        expected,
        target: { kind: "part", projectionPartId: part.id },
        assignment: { color: { kind: "catalog", colorId: "pla-white" }, spoolmanSpoolId: null },
      }).kind,
    ).toBe("updated");

    let updated = 0;
    const savedDefaults = loadRoleFilamentDefaults(repo, plan.id);
    for (const role of canonicalRoleOrder()) {
      const saved = savedDefaults[role];
      if (!saved?.filament_color_id && !saved?.filament_custom_hex) continue;
      const result = repo.assignAcceptedFilament({
        expected,
        target: { kind: "role", role },
        assignment: resolveFilamentAssignment(
          { color: { kind: "unset" }, spoolmanSpoolId: null },
          {
            colorId: saved.filament_color_id,
            customHex: saved.filament_custom_hex,
            spoolmanSpoolId: saved.spoolman_spool_id,
          },
        ),
      });
      expect(result.kind).toBe("updated");
      if (result.kind === "updated") updated += result.assigned.length;
    }
    expect(updated).toBeGreaterThan(0);
    expect(repo.listParts(plan.id).parts.find((p) => p.id === part.id)?.filament_custom_hex).toBe(
      "#ff6600",
    );

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

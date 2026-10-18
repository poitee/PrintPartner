import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { acceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { saveRoleFilamentDefault } from "../services/role-filament-store.js";
import { parseRequiredUnitToken } from "../services/required-units.js";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { registerPlanRoutes } from "./plans.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture(spoolman: boolean, desktop: boolean) {
  vi.stubEnv("PP_DESKTOP_REBUILD", desktop ? "1" : "0");
  const root = mkdtempSync(join(tmpdir(), "pp-apply-defaults-archived-"));
  const ports = createSelfHostPorts(root);
  const app = Fastify();
  cleanups.push(async () => {
    await app.close();
    await ports.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await ports.db.connect();
  const repo = ports.repository;
  const source = repo.createSource({ name: "Archive fixture", url: "https://github.com/example/archive" });
  const sourceRoot = join(root, "repos", String(source.id));
  mkdirSync(join(sourceRoot, "parts"), { recursive: true });
  writeFileSync(join(sourceRoot, "parts", "widget.stl"), "solid widget");
  repo.updateSource(source.id, { local_path: sourceRoot });
  repo.updateImportRules(source.id, ["parts/"]);
  const profile = repo.createProfile("Apply archived defaults", source.id);
  expect(acceptPlanForTest(repo, profile.id).merged).toBe(true);
  repo.setSetting(`feature_toggles:plan:${profile.id}`, JSON.stringify({ spoolman }));
  await registerPlanRoutes(app, {
    repo,
    dataDir: root,
    reposDir: join(root, "repos"),
    thumbsDir: join(root, "thumbs"),
  });
  const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
  if (accepted.kind !== "ready") throw new Error("Fixture Plan is not ready");
  expect(accepted.snapshot.parts).toHaveLength(1);
  expect(accepted.snapshot.parts[0]).toMatchObject({ included: true, effectiveRole: "primary" });
  for (const part of accepted.snapshot.parts) {
    for (const unit of part.units) {
      expect(repo.setAcceptedUnitCompletion({
        expected: acceptedPlanBasis(accepted.snapshot),
        token: parseRequiredUnitToken(unit.token),
        completed: true,
      }).kind).toBe("updated");
    }
  }
  return {
    repo,
    profileId: profile.id,
    apply: () => app.inject({
      method: "POST",
      url: `/plans/${profile.id}/apply-role-colors`,
      payload: { refresh_thumbnails: false },
    }),
    archive: () => {
      expect(repo.archiveAcceptedPlan({ expected: acceptedPlanBasis(accepted.snapshot) }).kind).toBe("archived");
    },
  };
}

describe.each([false, true])("apply role colors with desktop enabled=%s", (desktop) => {
  describe.each([false, true])("with Spoolman enabled=%s", (spoolman) => {
    it("returns zero for an active unmatched default and rejects the same Plan after archiving", async () => {
      const { repo, profileId, apply, archive } = await fixture(spoolman, desktop);
      saveRoleFilamentDefault(repo, profileId, "accent", {
        filament_color_id: "spoolman:inventory:filament:7",
        spoolman_spool_id: "spoolman:inventory:spool:11",
      });
      const active = await apply();
      expect(active.statusCode, active.body).toBe(200);
      expect(active.json()).toMatchObject({ updated: 0, thumbnails_cleared: 0 });

      archive();
      const before = repo.readAcceptedPlanOperationalSnapshot(profileId);
      const defaults = repo.getRoleFilaments(profileId);
      const archived = await apply();
      expect(archived.statusCode, archived.body).toBe(409);
      expect(archived.json()).toEqual({ detail: "Archived Plan Progress cannot be changed" });
      expect(repo.readAcceptedPlanOperationalSnapshot(profileId)).toEqual(before);
      expect(repo.getRoleFilaments(profileId)).toEqual(defaults);
    });

    it.each(["local", "spoolman"])("rejects an archived included role with a %s default", async (inventory) => {
      const { repo, profileId, apply, archive } = await fixture(spoolman, desktop);
      saveRoleFilamentDefault(repo, profileId, "primary", inventory === "local"
        ? { filament_custom_hex: "#123456" }
        : { filament_color_id: "spoolman:inventory:filament:7", spoolman_spool_id: "spoolman:inventory:spool:11" });
      archive();
      const before = repo.readAcceptedPlanOperationalSnapshot(profileId);
      const defaults = repo.getRoleFilaments(profileId);
      const response = await apply();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toEqual({ detail: "Archived Plan Progress cannot be changed" });
      expect(repo.readAcceptedPlanOperationalSnapshot(profileId)).toEqual(before);
      expect(repo.getRoleFilaments(profileId)).toEqual(defaults);
    });
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { AuthStore } from "../services/auth-store.js";

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-source-plan-availability-"));
  const ports = createSelfHostPorts(dataDir);
  await ports.db.connect();
  const auth = new AuthStore(getDb(ports.db.sqlite));
  const owner = auth.createUser({ displayName: "Manifest owner" });
  const foreign = auth.createUser({ displayName: "Other tenant" });
  const ownerCookie = `pp_session=${auth.createSession(owner.id, "email")}`;
  const foreignCookie = `pp_session=${auth.createSession(foreign.id, "email")}`;
  const repo = ports.repository;
  const source = repo.createSource({ name: "Owned manifest source", source_kind: "local" });
  const sourceRoot = join(dataDir, "repos", String(source.id));
  mkdirSync(sourceRoot, { recursive: true });
  const yaml = `format: print-partner-manifest-v2
version: 2
project: Owned manifest source
parts:
  - match: bracket.stl
    requirement: required
option_groups:
  toolhead:
    rule: pick_one
    variants:
      - id: stealthburner
        parts: ["bracket.stl"]
`;
  writeFileSync(join(sourceRoot, "print-partner.manifest.yaml"), yaml);
  writeFileSync(join(sourceRoot, "bracket.stl"), "solid bracket\nendsolid bracket\n");
  repo.updateSource(source.id, { local_path: sourceRoot });
  const imported = repo.importKitBundle({
    profile: { name: "Owned manifest kit" },
    kit_manifest: {
      name: "Owned manifest kit",
      base_source_id: String(source.id),
      selections: { toolhead: "stealthburner" },
    },
    layers: [{ layer_type: "addon", project: { name: "Missing warning source" } }],
  });
  const empty = repo.createSource({ name: "Source without a manifest", source_kind: "local" });
  const emptyRoot = join(dataDir, "repos", String(empty.id));
  mkdirSync(emptyRoot, { recursive: true });
  repo.updateSource(empty.id, { local_path: emptyRoot });
  const unsynced = repo.createSource({ name: "Unsynced source", source_kind: "local" });
  const app = await buildApp({
    ...loadConfig(), dataDir, multiUser: true, singleUserAuth: false, authRequired: true,
  }, ports);
  return {
    app, source, empty, unsynced, emptyRoot, sourceRoot, imported, yaml, ownerCookie, foreignCookie, repo,
    async close() {
      await app.close();
      await ports.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("Source manifest presence", () => {
  it("reads the owned canonical file and observes changes without inventing a manifest", async () => {
    const f = await fixture();
    try {
      for (const prefix of ["", "/api/v1"]) {
        const present = await f.app.inject({
          method: "GET", url: `${prefix}/sources/${f.source.id}/has-manifest`,
          headers: { cookie: f.ownerCookie },
        });
        expect(present.statusCode).toBe(200);
        expect(present.json()).toEqual({ has_manifest: true, manifest_kind: "repo" });
        for (const source of [f.empty, f.unsynced]) {
          const absent = await f.app.inject({
            method: "GET", url: `${prefix}/sources/${source.id}/has-manifest`,
            headers: { cookie: f.ownerCookie },
          });
          expect(absent.statusCode).toBe(200);
          expect(absent.json()).toEqual({ has_manifest: false, manifest_kind: null });
        }
      }
      const path = join(f.emptyRoot, "print-partner.manifest.yaml");
      symlinkSync(join(f.sourceRoot, "print-partner.manifest.yaml"), path);
      const unsafe = await f.app.inject({
        method: "GET", url: `/sources/${f.empty.id}/has-manifest`,
        headers: { cookie: f.ownerCookie },
      });
      expect(unsafe.statusCode).toBe(200);
      expect(unsafe.json()).toEqual({ has_manifest: false, manifest_kind: null });
      rmSync(path);
      writeFileSync(path, f.yaml);
      const added = await f.app.inject({
        method: "GET", url: `/sources/${f.empty.id}/has-manifest`,
        headers: { cookie: f.ownerCookie },
      });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toEqual({ has_manifest: true, manifest_kind: "repo" });
      rmSync(path);
      const removed = await f.app.inject({
        method: "GET", url: `/sources/${f.empty.id}/has-manifest`,
        headers: { cookie: f.ownerCookie },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ has_manifest: false, manifest_kind: null });
    } finally {
      await f.close();
    }
  });

  it("denies foreign, missing, invalid, and unauthenticated IDs without leaking presence", async () => {
    const f = await fixture();
    try {
      for (const prefix of ["", "/api/v1"]) {
        for (const [id, cookie] of [
          [f.source.id, f.foreignCookie], [999999999, f.ownerCookie],
          ["not-an-id", f.ownerCookie], [0, f.ownerCookie], [-1, f.ownerCookie],
        ]) {
          const result = await f.app.inject({
            method: "GET", url: `${prefix}/sources/${id}/has-manifest`,
            headers: { cookie: String(cookie) },
          });
          expect(result.statusCode).toBe(404);
          expect(result.json()).toEqual({ detail: "Source not found" });
        }
        const denied = await f.app.inject({
          method: "GET", url: `${prefix}/sources/${f.source.id}/has-manifest`,
        });
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toEqual({ detail: "Authentication required" });
      }
      const v2 = await f.app.inject({
        method: "GET", url: `/api/v2/sources/${f.source.id}/has-manifest`,
        headers: { cookie: f.ownerCookie },
      });
      expect(v2.statusCode).toBe(404);
    } finally {
      await f.close();
    }
  });
});

const unsupportedRoutes = [
  {
    path: "/sources/maintenance", prefixes: ["", "/api/v1"],
    code: "source_maintenance_unsupported",
    detail: "Source maintenance reporting is not supported by this web API.",
  },
  {
    path: "/plans/maintenance", prefixes: ["", "/api/v1", "/api/v2"],
    code: "plan_maintenance_unsupported",
    detail: "Plan maintenance reporting is not supported by this web API.",
  },
  {
    path: "/plans/:id/manifest-summary", prefixes: ["", "/api/v1", "/api/v2"],
    code: "plan_manifest_summary_unsupported",
    detail: "Plan manifest summary is not supported by this web API.",
  },
  {
    path: "/plans/:id/manifest-warnings", prefixes: ["", "/api/v1", "/api/v2"],
    code: "plan_manifest_warnings_unsupported",
    detail: "Plan manifest warning reporting is not supported by this web API.",
  },
];

describe("unsupported Source and Plan reports", () => {
  for (const route of unsupportedRoutes) {
    it(`refuses ${route.path} even with a real manifest and import warning`, async () => {
      const f = await fixture();
      try {
        const manifest = await f.app.inject({
          method: "GET", url: `/sources/${f.source.id}/repo-manifest`,
          headers: { cookie: f.ownerCookie },
        });
        expect(manifest.statusCode).toBe(200);
        expect(manifest.json()).toMatchObject({ exists: true, yaml: f.yaml });
        expect(f.imported.warnings).toEqual(['Layer addon: no local repo "Missing warning source".']);
        const before = f.repo.readEditableKitRecipe(f.imported.profile_id);
        const sourcesBefore = f.repo.listSources();
        for (const prefix of route.prefixes) {
          for (const [id, cookie] of [
            [f.imported.profile_id, f.ownerCookie],
            [f.imported.profile_id, f.foreignCookie],
            [999999999, f.ownerCookie], ["not-an-id", f.ownerCookie],
          ]) {
            for (let repeat = 0; repeat < 2; repeat++) {
              const result = await f.app.inject({
                method: "GET", url: prefix + route.path.replace(":id", String(id)),
                headers: { cookie: String(cookie) },
              });
              expect(result.statusCode).toBe(501);
              expect(result.json()).toEqual({ code: route.code, detail: route.detail });
            }
          }
          const denied = await f.app.inject({
            method: "GET", url: prefix + route.path.replace(":id", String(f.imported.profile_id)),
          });
          expect(denied.statusCode).toBe(401);
          expect(denied.json()).toEqual({ detail: "Authentication required" });
        }
        expect(f.repo.readEditableKitRecipe(f.imported.profile_id)).toEqual(before);
        expect(f.repo.listSources()).toEqual(sourcesBefore);
      } finally {
        await f.close();
      }
    });
  }
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { AuthStore } from "../services/auth-store.js";

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-manifest-export-draft-"));
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
  const app = await buildApp({
    ...loadConfig(), dataDir, multiUser: true, singleUserAuth: false, authRequired: true,
  }, ports);
  return {
    app, source, imported, yaml, ownerCookie, foreignCookie,
    async close() {
      await app.close();
      await ports.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("community manifest submission draft export", () => {
  it("refuses a submission bundle even with a stored manifest and a real import warning", async () => {
    const f = await fixture();
    try {
      const manifest = await f.app.inject({
        method: "GET", url: `/sources/${f.source.id}/repo-manifest`,
        headers: { cookie: f.ownerCookie },
      });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.json()).toMatchObject({ exists: true, yaml: f.yaml });
      expect(f.imported.warnings).toEqual(['Layer addon: no local repo "Missing warning source".']);
      const kitUrl = `/plans/${f.imported.profile_id}/kit-manifest`;
      const before = await f.app.inject({ method: "GET", url: kitUrl, headers: { cookie: f.ownerCookie } });
      expect(before.statusCode).toBe(200);
      expect(before.json().kit).toMatchObject({
        name: "Owned manifest kit", base_source_id: String(f.source.id),
        selections: { toolhead: "stealthburner" },
      });
      for (const prefix of ["", "/api/v1"]) {
        const response = await f.app.inject({
          method: "POST", url: `${prefix}/manifest-registry/export-draft`,
          headers: { cookie: f.ownerCookie },
          payload: { source_id: f.source.id, profile_id: f.imported.profile_id, warnings: f.imported.warnings },
        });
        expect(response.statusCode).toBe(501);
        expect(response.json()).toEqual({
          code: "manifest_export_draft_unsupported",
          detail: "Community manifest submission draft export is not supported by this web API.",
        });
      }
      const after = await f.app.inject({ method: "GET", url: kitUrl, headers: { cookie: f.ownerCookie } });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual(before.json());
    } finally {
      await f.close();
    }
  });

  it("preserves authentication and gives foreign, missing, and bodyless requests the same refusal", async () => {
    const f = await fixture();
    try {
      const foreignKit = await f.app.inject({
        method: "GET", url: `/plans/${f.imported.profile_id}/kit-manifest`,
        headers: { cookie: f.foreignCookie },
      });
      expect(foreignKit.statusCode).toBe(404);
      expect(foreignKit.json()).toEqual({ detail: "Profile not found" });
      const cases = [
        { cookie: f.foreignCookie, payload: { source_id: f.source.id, profile_id: f.imported.profile_id } },
        { cookie: f.ownerCookie, payload: { source_id: 999999999, profile_id: 999999999 } },
        { cookie: f.ownerCookie },
      ];
      for (const prefix of ["", "/api/v1"]) {
        for (const { cookie, payload } of cases) {
          const response = await f.app.inject({
            method: "POST", url: `${prefix}/manifest-registry/export-draft`,
            headers: { cookie }, payload,
          });
          expect(response.statusCode).toBe(501);
          expect(response.json()).toEqual({
            code: "manifest_export_draft_unsupported",
            detail: "Community manifest submission draft export is not supported by this web API.",
          });
        }
        const denied = await f.app.inject({ method: "POST", url: `${prefix}/manifest-registry/export-draft` });
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toEqual({ detail: "Authentication required" });
      }
      const unavailable = await f.app.inject({
        method: "POST", url: "/api/v2/manifest-registry/export-draft", headers: { cookie: f.ownerCookie },
      });
      expect(unavailable.statusCode).toBe(404);
    } finally {
      await f.close();
    }
  });
});

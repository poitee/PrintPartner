import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { referenceShareSchema } from "@print-partner/contracts";
import { registerReferenceSharingRoutes } from "./reference-sharing.js";
import { tenantStorage } from "../middleware/tenant-context.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pp-reference-share-"));
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const repo = ports.repository!;
  const source = repo.createSource({ name: "Local design", source_kind: "local", local_path: "/private/customer-models" });
  const profile = repo.createProfile("Reference Build", source.id);
  const app = Fastify();
  registerReferenceSharingRoutes(app, repo);
  cleanups.push(async () => { await app.close(); await ports.db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, repo, profile, source };
}

describe("references-only sharing routes", () => {
  it("exports local Sources without private paths, progress, or model content", async () => {
    const { app, profile } = await fixture();
    const response = await app.inject(`/plans/${profile.id}/reference-share`);
    expect(response.statusCode).toBe(200);
    const manifest = referenceShareSchema.parse(response.json().manifest);
    expect(manifest.sources[0]?.location).toEqual({ kind: "manual" });
    expect(response.body).not.toContain("/private/customer-models");
    expect(manifest).not.toHaveProperty("print_progress");
    expect(manifest).not.toHaveProperty("order_number");
    expect(manifest).not.toHaveProperty("files");
  });

  it("creates a deterministic Git ZIP containing only the previewed manifest and text guidance", async () => {
    const { app, profile } = await fixture();
    const preview = await app.inject(`/plans/${profile.id}/reference-share`);
    const payload = preview.json().manifest;
    const first = await app.inject({ method: "POST", url: "/reference-shares/git", payload });
    const second = await app.inject({ method: "POST", url: "/reference-shares/git", payload });
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload).toEqual(second.rawPayload);
    const entries = unzipSync(first.rawPayload);
    expect(Object.keys(entries).sort()).toEqual([".gitignore", "README.md", "printpartner.share.json"]);
    expect(JSON.parse(strFromU8(entries["printpartner.share.json"]!))).toEqual(payload);
    expect(strFromU8(entries["README.md"]!)).toContain("not model files");
  });

  it("validates without mutating Sources and rejects embedded files", async () => {
    const { app, repo, source, profile } = await fixture();
    const before = repo.getProjectRow(source.id);
    const payload = (await app.inject(`/plans/${profile.id}/reference-share`)).json().manifest;
    const valid = await app.inject({ method: "POST", url: "/reference-shares/validate", payload });
    expect(valid.statusCode).toBe(200);
    expect(repo.getProjectRow(source.id)).toEqual(before);
    for (const url of ["/reference-shares/validate", "/reference-shares/git"]) {
      expect((await app.inject({ method: "POST", url, payload: { ...payload, files: { "model.stl": "bytes" } } })).statusCode).toBe(400);
    }
  });

  it("rejects Git bundles when pretty JSON exceeds 4 MiB despite a smaller request", async () => {
    const { app } = await fixture();
    const payload = referenceShareSchema.parse({
      format: "printpartner-reference-share", version: 1, kind: "build", title: "Large recipe",
      sources: [{ key: "source-1", name: "Source", location: { kind: "manual" },
        revision: { branch: null, tag: null, commit: null }, file_rules: [] }],
      layers: [{ source: "source-1", role: "base" }], selections: {}, include: [], exclude: [], replacements: {},
      parts: Array.from({ length: 30000 }, (_, index) => ({
        source: "source-1", path: `part-${index}.stl`, quantity: 1, included: true, role: "primary", color: null,
      })),
    });
    const limit = 4 * 1024 * 1024;
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(limit);
    expect(Buffer.byteLength(JSON.stringify(payload, null, 2))).toBeGreaterThan(limit);
    const response = await app.inject({ method: "POST", url: "/reference-shares/git", payload });
    expect(response.statusCode).toBe(413);
  });

  it("rejects missing Builds and invalid ids", async () => {
    const { app } = await fixture();
    expect((await app.inject("/plans/99999/reference-share")).statusCode).toBe(404);
    expect((await app.inject("/plans/1.5/reference-share")).statusCode).toBe(400);
  });

  it("does not export a Build owned by another tenant", async () => {
    const { app, profile } = await fixture();
    const response = await tenantStorage.run("other-tenant", async () => {
      const result = await app.inject(`/plans/${profile.id}/reference-share`);
      return result;
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("Reference Build");
  });

  it("imports a mapped Build once and leaves an unmapped Library unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-share-route-"));
    cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
    mkdirSync(join(root, "parts"), { recursive: true });
    writeFileSync(join(root, "parts", "bracket.stl"), "solid bracket\nendsolid bracket\n");
    const { app, repo, source } = await fixture();
    const commit = "b".repeat(40);
    const acquired = repo.createSource({ name: "Acquired", url: "https://github.com/acme/widget", source_kind: "github", local_path: root });
    repo.updateSource(acquired.id, { last_commit_sha: commit });
    const manifest = {
      format: "printpartner-reference-share", version: 1, kind: "build", title: "Imported recipe",
      sources: [{ key: "source-1", name: source.name, location: { kind: "publisher", url: "https://github.com/acme/widget" },
        revision: { branch: "main", tag: null, commit }, file_rules: ["parts/bracket.stl"] }],
      layers: [{ source: "source-1", role: "base" }], selections: {}, include: ["parts/bracket.stl"], exclude: [], replacements: {},
      parts: [{ source: "source-1", path: "parts/bracket.stl", quantity: 2, included: true, role: "accent", color: "#112233" }],
    };
    const refused = await app.inject({ method: "POST", url: "/reference-shares/imports", payload: { manifest, mapping: {} } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().dependencies[0].status).toBe("File required");
    expect(repo.listProfileHeaders().some((header) => header.name === "Imported recipe")).toBe(false);
    const payload = { manifest, mapping: { "source-1": acquired.id } };
    const created = await app.inject({ method: "POST", url: "/reference-shares/imports", payload });
    const repeated = await app.inject({ method: "POST", url: "/reference-shares/imports", payload });
    expect(created.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ profile_id: created.json().profile_id, created: false });
    expect(repo.getProfileLayers(created.json().profile_id).map((layer) => layer.project_id)).toEqual([acquired.id]);
    const draft = repo.listPlanDraftIdentities(created.json().profile_id).find((entry) => entry.state === "open");
    expect(draft).toBeDefined();
    const importedPart = draft ? repo.getPlanDraft(created.json().profile_id, draft.id)?.parts[0] : null;
    expect(importedPart).toMatchObject({
      quantityEffective: 2,
      roleOverride: "accent",
      filamentCustomHex: "#112233",
    });
  });

  it("exports a collection for the selected Sources only", async () => {
    const { app, repo, source } = await fixture();
    const other = repo.createSource({ name: "Not selected", url: "https://github.com/acme/other", source_kind: "github" });
    const response = await app.inject({
      method: "POST", url: "/reference-shares/collections",
      payload: { title: "Bench", source_ids: [source.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.sources.map((entry: { name: string }) => entry.name)).toEqual(["Local design"]);
    expect(response.body).not.toContain(other.name);
    const missing = await app.inject({
      method: "POST", url: "/reference-shares/collections",
      payload: { title: "Bench", source_ids: [99999] },
    });
    expect(missing.statusCode).toBe(404);
  });
});

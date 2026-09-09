import { mkdtempSync, rmSync } from "node:fs";
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
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReferenceShare } from "@print-partner/contracts";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadKitManifest } from "./kit-manifest-store.js";
import {
  ReferenceShareImportRefused,
  importReferenceShareBuild,
  inspectReferenceShare,
} from "./reference-share-import.js";
import { exportCollectionReferenceShare } from "./reference-sharing.js";

const COMMIT = "a".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function manifest(name = "Shared Build"): Extract<ReferenceShare, { kind: "build" }> {
  return {
    format: "printpartner-reference-share",
    version: 1,
    kind: "build",
    title: "Shared Build",
    sources: [{
      key: "source-1",
      name,
      location: { kind: "publisher", url: "https://github.com/acme/widget" },
      revision: { branch: "main", tag: null, commit: COMMIT },
      file_rules: ["parts/bracket.stl"],
    }],
    layers: [{ source: "source-1", role: "base" }],
    selections: { size: "65mm" },
    include: ["parts/bracket.stl"],
    exclude: [],
    replacements: {},
    parts: [{
      source: "source-1",
      path: "parts/bracket.stl",
      quantity: 2,
      included: true,
      role: "accent",
      color: "#112233",
    }],
  };
}

async function portsFor(directory: string) {
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  cleanups.push(async () => { await ports.db.close(); rmSync(directory, { recursive: true, force: true }); });
  return ports.repository!;
}

function writeStl(root: string): void {
  mkdirSync(join(root, "parts"), { recursive: true });
  writeFileSync(join(root, "parts", "bracket.stl"), "solid bracket\nendsolid bracket\n");
}

describe("reference share import", () => {
  it("refuses an empty Library without creating a Build or matching by name", async () => {
    const repo = await portsFor(mkdtempSync(join(tmpdir(), "pp-share-empty-")));
    const share = manifest("Same Name");
    const decoy = repo.createSource({ name: "Same Name", source_kind: "local", local_path: "/tmp/unused-decoy" });
    const inspection = inspectReferenceShare(repo, share, {});
    expect(inspection.printable).toBe(false);
    expect(inspection.dependencies).toEqual([
      { source_key: "source-1", path: "parts/bracket.stl", status: "File required" },
    ]);
    expect(() => importReferenceShareBuild(repo, share, {})).toThrow(ReferenceShareImportRefused);
    expect(repo.listProfileHeaders()).toEqual([]);
    expect(repo.getProjectRow(decoy.id)?.importedPaths ?? null).toBeNull();
  });

  it("keeps a local file with an unverified revision out of a printable import", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-share-local-"));
    writeStl(root);
    const repo = await portsFor(mkdtempSync(join(tmpdir(), "pp-share-local-db-")));
    const source = repo.createSource({ name: "Desk copy", source_kind: "local", local_path: root });
    const share = manifest();
    share.sources[0] = { ...share.sources[0]!, revision: { branch: null, tag: null, commit: null }, location: { kind: "manual" } };
    const inspection = inspectReferenceShare(repo, share, { "source-1": source.id });
    expect(inspection.dependencies[0]?.status).toBe("Revision unverified");
    expect(inspection.printable).toBe(false);
    expect(repo.listProfileHeaders()).toEqual([]);
  });

  it("creates one Build from an explicit ready mapping and repeats without a duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-share-ready-"));
    writeStl(root);
    const repo = await portsFor(mkdtempSync(join(tmpdir(), "pp-share-ready-db-")));
    const decoy = repo.createSource({ name: "Shared Build source", source_kind: "local", local_path: "/tmp/decoy-models" });
    const source = repo.createSource({
      name: "Acquired widget",
      url: "https://github.com/acme/widget",
      source_kind: "github",
      local_path: root,
    });
    repo.updateSource(source.id, { last_commit_sha: COMMIT });
    const share = manifest("Shared Build source");
    const beforeRules = repo.getProjectRow(source.id)?.importedPaths ?? null;
    const beforePrinters = repo.getSetting("printer.plan_bindings");
    const mapping = { "source-1": source.id };
    expect(inspectReferenceShare(repo, share, mapping).printable).toBe(true);

    const first = importReferenceShareBuild(repo, share, mapping);
    const second = importReferenceShareBuild(repo, share, mapping);
    expect(second).toMatchObject({ profile_id: first.profile_id, created: false });
    expect(repo.listProfileHeaders()).toHaveLength(1);
    expect(repo.listProfileHeaders()[0]).toMatchObject({ id: first.profile_id, order_number: null });
    const layers = repo.getProfileLayers(first.profile_id);
    expect(layers.map((layer) => layer.project_id)).toEqual([source.id]);
    expect(layers.some((layer) => layer.project_id === decoy.id)).toBe(false);
    expect(repo.getProjectRow(source.id)?.importedPaths ?? null).toBe(beforeRules);
    expect(repo.getSetting("printer.plan_bindings")).toBe(beforePrinters);
    expect(loadKitManifest(repo, first.profile_id).selections).toEqual({ size: "65mm" });
    expect(loadKitManifest(repo, first.profile_id).include).toEqual(["parts/bracket.stl"]);
    const draft = repo.listPlanDraftIdentities(first.profile_id).find((entry) => entry.state === "open");
    expect(draft).toBeDefined();
    const importedPart = draft ? repo.getPlanDraft(first.profile_id, draft.id)?.parts[0] : null;
    expect(importedPart).toMatchObject({
      relativePath: "parts/bracket.stl",
      quantityEffective: 2,
      roleOverride: "accent",
      filamentCustomHex: "#112233",
    });
  });

  it("rolls back a Build when publication of the import receipt fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-share-rollback-"));
    writeStl(root);
    const repo = await portsFor(mkdtempSync(join(tmpdir(), "pp-share-rollback-db-")));
    const source = repo.createSource({ name: "Acquired widget", source_kind: "github", local_path: root });
    repo.updateSource(source.id, { last_commit_sha: COMMIT });
    const original = repo.setSetting.bind(repo);
    repo.setSetting = (key: string, value: string) => {
      if (key.startsWith("reference-share.import.")) throw new Error("injected receipt failure");
      return original(key, value);
    };
    expect(() => importReferenceShareBuild(repo, manifest(), { "source-1": source.id })).toThrow(/injected receipt failure/);
    expect(repo.listProfileHeaders()).toEqual([]);
  });

  it("refuses part choices that a Working Plan cannot represent", async () => {
    const root = mkdtempSync(join(tmpdir(), "pp-share-invalid-"));
    writeStl(root);
    const repo = await portsFor(mkdtempSync(join(tmpdir(), "pp-share-invalid-db-")));
    const source = repo.createSource({ name: "Acquired widget", source_kind: "github", local_path: root });
    repo.updateSource(source.id, { last_commit_sha: COMMIT });
    const share = manifest();
    share.parts[0] = { ...share.parts[0]!, quantity: 10_001 };
    expect(() => importReferenceShareBuild(repo, share, { "source-1": source.id })).toThrow(/quantity or role/);
    expect(repo.listProfileHeaders()).toEqual([]);

    share.parts[0] = { ...share.parts[0]!, quantity: 2 };
    share.parts.push({ ...share.parts[0]!, color: "#aabbcc" });
    expect(() => importReferenceShareBuild(repo, share, { "source-1": source.id })).toThrow(/duplicated/);
    expect(repo.listProfileHeaders()).toEqual([]);
  });

  it("exports only the Library Sources the operator selected", async () => {
    const repo = await portsFor(mkdtempSync(join(tmpdir(), "pp-share-collection-")));
    const chosen = repo.createSource({
      name: "Chosen",
      url: "https://github.com/acme/chosen",
      source_kind: "github",
    });
    repo.updateSource(chosen.id, { last_commit_sha: COMMIT });
    repo.createSource({ name: "Left out", url: "https://github.com/acme/other", source_kind: "github" });
    const exported = exportCollectionReferenceShare(repo, "Bench sources", [chosen.id]);
    expect(exported.manifest.kind).toBe("collection");
    expect(exported.manifest.sources.map((source) => source.name)).toEqual(["Chosen"]);
    expect(JSON.stringify(exported.manifest)).not.toContain("Left out");
    expect(exported.manifest.sources[0]?.revision.commit).toBe(COMMIT);
  });
});

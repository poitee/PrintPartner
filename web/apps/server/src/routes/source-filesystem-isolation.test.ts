import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, createPorts } from "../app.js";
import type { ServerConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { projects } from "../db/schema.js";
import type { SelfHostDbStore } from "../adapters/self-host/index.js";
import {
  ASSISTANT_TOOL_SPECS,
  applyAssistantAction,
  invokeAssistantTool,
} from "../assistant/tools.js";

const cleanups: Array<() => Promise<void>> = [];

async function sourceApp(multiUser: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-source-isolation-"));
  const config: ServerConfig = {
    ...loadConfig(),
    dataDir,
    deployMode: "self-host",
    multiUser,
    singleUserAuth: false,
    authRequired: false,
    staticDir: null,
  };
  const ports = createPorts(config);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  const repo = ports.repository;
  if (!repo) throw new Error("Expected a self-host repository");
  cleanups.push(async () => {
    await app.close();
    await ports.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    app,
    dataDir,
    repo,
    reposDir: join(dataDir, "repos"),
    db: getDb((ports.db as SelfHostDbStore).sqlite),
  };
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("isolated Source filesystem policy", () => {
  it("rejects an unexpected upload file field without hanging", async () => {
    const { app, repo } = await sourceApp(true);
    const source = repo.createSource({ name: "Unexpected upload", source_kind: "local" });
    const boundary = "----pp-unexpected-source-file";
    const response = await app.inject({
      method: "POST",
      url: `/sources/${source.id}/upload-files`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="unexpected"; filename="ignored.stl"\r\n' +
          "Content-Type: model/stl\r\n\r\n" +
          "solid ignored\nendsolid ignored\n" +
          `\r\n--${boundary}--\r\n`,
      ),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: "At least one file is required" });
  });

  it("rejects local_path from Source POST, PATCH, and assistant proposals", async () => {
    const { app, dataDir, repo } = await sourceApp(true);
    const external = join(dataDir, "external");
    mkdirSync(external);

    const rejectedCreate = await app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Injected", source_kind: "local", local_path: external },
    });
    expect(rejectedCreate.statusCode).toBe(400);
    expect(rejectedCreate.json().detail).toMatch(/local_path/i);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Managed", source_kind: "local" },
    });
    expect(createdResponse.statusCode).toBe(200);
    const created = createdResponse.json<{ id: number; local_path: string | null }>();
    expect(created.local_path).toBeNull();

    const rejectedPatch = await app.inject({
      method: "PATCH",
      url: `/sources/${created.id}`,
      payload: { local_path: external },
    });
    expect(rejectedPatch.statusCode).toBe(400);
    expect(rejectedPatch.json().detail).toMatch(/local_path/i);

    const assistantSpec = ASSISTANT_TOOL_SPECS.find(
      (candidate) => candidate.name === "propose_add_source",
    );
    expect(assistantSpec?.input_schema.properties).not.toHaveProperty("local_path");

    const proposal = await invokeAssistantTool(
      "propose_add_source",
      { name: "Assistant injected", source_kind: "local", local_path: external },
      { repo },
    );
    expect(JSON.parse(proposal.content).error).toMatch(/local_path/i);
    expect(proposal.proposedAction).toBeUndefined();

    const safeProposal = await invokeAssistantTool(
      "propose_add_source",
      { name: "Tampered assistant", source_kind: "local" },
      { repo },
    );
    const tamperedAction = {
      ...safeProposal.proposedAction!,
      params: { ...safeProposal.proposedAction!.params, local_path: external },
    };
    const applyResult = await applyAssistantAction(tamperedAction, {
      repo,
      jobs: { start: async () => "job" } as never,
    });
    expect(applyResult.ok).toBe(false);
    expect(applyResult.detail).toMatch(/local_path/i);
    expect(repo.listSources().some((source) => source.name === "Tampered assistant")).toBe(false);
  });

  it("rejects tampered persisted paths before STL and documentation reads", async () => {
    const { app, dataDir, db, repo } = await sourceApp(true);
    const external = join(dataDir, "external");
    mkdirSync(external);
    writeFileSync(join(external, "secret.stl"), "solid secret\nendsolid secret\n");
    writeFileSync(join(external, "README.md"), "outside secret");
    const source = repo.createSource({ name: "Tampered", source_kind: "local" });
    db.update(projects)
      .set({ localPath: external })
      .where(eq(projects.id, source.id))
      .run();

    const summary = await app.inject({ method: "GET", url: `/sources/${source.id}` });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().local_path).toBeNull();

    const tree = await app.inject({ method: "GET", url: `/sources/${source.id}/stl-tree` });
    expect(tree.statusCode).toBe(400);
    expect(tree.body).not.toContain("secret.stl");

    const mesh = await app.inject({
      method: "GET",
      url: `/sources/${source.id}/stl/secret.stl/mesh`,
    });
    expect(mesh.statusCode).toBe(404);
    expect(mesh.body).not.toContain("solid secret");

    const docs = await app.inject({
      method: "GET",
      url: `/sources/${source.id}/docs/README.md`,
    });
    expect(docs.statusCode).toBe(404);
    expect(docs.body).not.toContain("outside secret");
  });

  it("allows an owned workspace but rejects a symlinked Source root and document", async () => {
    const { app, dataDir, db, repo, reposDir } = await sourceApp(true);
    const owned = repo.createSource({ name: "Owned", source_kind: "local" });
    const ownedRoot = join(reposDir, String(owned.id));
    mkdirSync(ownedRoot, { recursive: true });
    repo.updateSource(owned.id, {
      localPath: ownedRoot,
      last_synced_at: "2026-09-04T00:00:00.000Z",
    });
    writeFileSync(join(ownedRoot, "owned.stl"), "solid owned\nendsolid owned\n");
    const outsideDoc = join(dataDir, "outside.md");
    writeFileSync(outsideDoc, "outside document");
    symlinkSync(outsideDoc, join(ownedRoot, "README.md"));

    const tree = await app.inject({ method: "GET", url: `/sources/${owned.id}/stl-tree` });
    expect(tree.statusCode).toBe(200);
    expect(tree.body).toContain("owned.stl");
    const escapedDoc = await app.inject({
      method: "GET",
      url: `/sources/${owned.id}/docs/README.md`,
    });
    expect(escapedDoc.statusCode).toBe(404);
    expect(escapedDoc.body).not.toContain("outside document");

    const outsideText = join(dataDir, "outside.txt");
    writeFileSync(outsideText, "assistant secret");
    symlinkSync(outsideText, join(ownedRoot, "notes.txt"));
    const assistantRead = await invokeAssistantTool(
      "read_source_file",
      { source: String(owned.id), path: "notes.txt" },
      { repo },
    );
    expect(JSON.parse(assistantRead.content).error).toMatch(/not found|invalid path/i);
    expect(assistantRead.content).not.toContain("assistant secret");

    const externalRoot = join(dataDir, "external-root");
    mkdirSync(externalRoot);
    writeFileSync(join(externalRoot, "escaped.stl"), "solid escaped\nendsolid escaped\n");
    const symlinked = repo.createSource({ name: "Symlinked", source_kind: "local" });
    symlinkSync(externalRoot, join(reposDir, String(symlinked.id)), "dir");
    db.update(projects)
      .set({ localPath: join(reposDir, String(symlinked.id)) })
      .where(eq(projects.id, symlinked.id))
      .run();

    const escapedTree = await app.inject({
      method: "GET",
      url: `/sources/${symlinked.id}/stl-tree`,
    });
    expect(escapedTree.statusCode).toBe(400);
    expect(escapedTree.body).not.toContain("escaped.stl");
  });

  it("keeps revision locators source-owned and can replace a tampered active path", async () => {
    const { dataDir, db, repo, reposDir } = await sourceApp(true);
    const first = repo.createSource({ name: "First revision owner" });
    const second = repo.createSource({ name: "Second revision owner" });
    const secondRoot = join(reposDir, String(second.id), "revisions", "foreign");
    mkdirSync(secondRoot, { recursive: true });
    const foreign = repo.recordSourceRevision({
      sourceId: first.id,
      upstreamRevisionKey: "foreign",
      manifestDigest: "a".repeat(64),
      snapshotLocator: `${second.id}/revisions/foreign`,
      syncedAt: "2026-09-04T00:00:00.000Z",
      completeness: "complete",
    });
    const original = repo.getSourceActivationObservation(first.id);
    if (!original) throw new Error("Expected Source activation observation");
    expect(() =>
      repo.activateSourceRevision({
        sourceId: first.id,
        revisionId: foreign.id,
        observed: original,
        sourceVersion: foreign.upstream_revision_key,
      }),
    ).toThrow(/Source workspace/i);

    const ownedRoot = join(reposDir, String(first.id), "revisions", "owned");
    mkdirSync(ownedRoot, { recursive: true });
    const owned = repo.recordSourceRevision({
      sourceId: first.id,
      upstreamRevisionKey: "owned",
      manifestDigest: "b".repeat(64),
      snapshotLocator: `${first.id}/revisions/owned`,
      syncedAt: "2026-09-04T01:00:00.000Z",
      completeness: "complete",
    });
    const tamperedPath = join(dataDir, "tampered-active-path");
    mkdirSync(tamperedPath);
    db.update(projects)
      .set({ localPath: tamperedPath })
      .where(eq(projects.id, first.id))
      .run();
    const tampered = repo.getSourceActivationObservation(first.id);
    if (!tampered) throw new Error("Expected tampered Source activation observation");

    expect(
      repo.activateSourceRevision({
        sourceId: first.id,
        revisionId: owned.id,
        observed: tampered,
        sourceVersion: owned.upstream_revision_key,
      }).local_path,
    ).toBe(ownedRoot);
  });

  it("preserves explicitly trusted single-user local folders", async () => {
    const { app, dataDir } = await sourceApp(false);
    const localRoot = join(dataDir, "trusted-local-source");
    mkdirSync(localRoot);
    writeFileSync(join(localRoot, "local.stl"), "solid local\nendsolid local\n");

    const response = await app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Trusted local", source_kind: "local", local_path: localRoot },
    });

    expect(response.statusCode).toBe(200);
    const source = response.json<{ id: number; local_path: string; content_available: boolean }>();
    expect(source.local_path).toBe(localRoot);
    expect(source.content_available).toBe(true);
    const tree = await app.inject({ method: "GET", url: `/sources/${source.id}/stl-tree` });
    expect(tree.statusCode).toBe(200);
    expect(tree.body).toContain("local.stl");
  });
});

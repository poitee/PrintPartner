import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import { importRulesForProject, scanRepo } from "@print-partner/domain";
import type { AppRepository } from "../db/repository.js";
import {
  editableSourceManifestPath,
  findEditableSourceManifestPath,
} from "../services/source-workspace.js";

const MANIFEST_FILE = "print-partner.manifest.yaml";

type RouteDeps = { repo: AppRepository };

function requireLocalPath(repo: AppRepository, sourceId: number) {
  const row = repo.getProjectRow(sourceId);
  if (!row?.localPath) throw new Error("Source has no local_path — sync or import first");
  return row;
}

export async function registerRepoManifestRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/sources/:id/repo-manifest", async (request) => {
    const id = Number((request.params as { id: string }).id);
    const row = requireLocalPath(deps.repo, id);
    const path = findEditableSourceManifestPath({
      reposDir: deps.repo.reposDir,
      sourceId: id,
      contentRoot: row.localPath!,
    });
    let yaml: string;
    let exists = false;
    try {
      if (!path) throw new Error("Manifest not found");
      yaml = readFileSync(path, "utf8");
      exists = true;
    } catch {
      yaml = [
        "format: print-partner-manifest-v2",
        "version: 2",
        `project: ${row.name}`,
        "parts: []",
      ].join("\n");
    }
    return {
      source_id: id,
      path: MANIFEST_FILE,
      exists,
      manifest_kind: exists ? "repo" : null,
      yaml,
      document: { format: "print-partner-manifest-v2", version: 2, raw: yaml },
    };
  });

  app.put("/sources/:id/repo-manifest", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    requireLocalPath(deps.repo, id);
    const body = request.body as { yaml?: string };
    const yaml = String(body.yaml ?? "");
    if (!yaml.trim()) return reply.status(400).send({ detail: "yaml is required" });
    const path = editableSourceManifestPath(deps.repo.reposDir, id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yaml, "utf8");
    return { source_id: id, saved: true };
  });

  app.get("/sources/:id/manifest-builder", async (request) => {
    const id = Number((request.params as { id: string }).id);
    const row = requireLocalPath(deps.repo, id);
    const rules = importRulesForProject(row.importedPaths);
    const scanned = scanRepo(row.localPath!, "base", rules);
    return {
      source_id: id,
      source: {
        id: row.id,
        name: row.name,
        url: row.url,
        branch: row.branch,
        tag: row.tag,
        local_path: row.localPath,
      },
      path: MANIFEST_FILE,
      yaml: "",
      document: { format: "print-partner-manifest-v2", version: 2, parts: [] },
      scanned_parts: scanned.map((p) => ({
        match: p.matchKey,
        relative_path: p.relativePath,
      })),
    };
  });
}

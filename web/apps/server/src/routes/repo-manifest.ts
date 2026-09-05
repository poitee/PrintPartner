import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { importRulesForProject, scanRepo } from "@print-partner/domain";
import {
  SourceActivationConflictError,
  type AppRepository,
} from "../db/repository.js";
import {
  InvalidSourceManifestError,
  publishSourceManifestRevision,
} from "../services/local-source-revision.js";
import {
  archiveLegacySourceManifest,
  inspectLegacySourceManifest,
} from "../services/legacy-source-manifest.js";
import { findSourceManifestPath } from "../services/source-workspace.js";

const MANIFEST_FILE = "print-partner.manifest.yaml";

type RouteDeps = { repo: AppRepository };

function requireLocalPath(repo: AppRepository, sourceId: number) {
  const row = repo.getProjectRow(sourceId);
  if (!row?.localPath) throw new Error("Source has no local_path; sync or import first");
  return row;
}

export async function registerRepoManifestRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/sources/:id/repo-manifest", async (request) => {
    const id = Number((request.params as { id: string }).id);
    const row = requireLocalPath(deps.repo, id);
    const path = findSourceManifestPath(row.localPath!);
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
    let legacy: Awaited<ReturnType<typeof inspectLegacySourceManifest>>;
    try {
      legacy = await inspectLegacySourceManifest({
        reposDir: deps.repo.reposDir,
        sourceId: id,
      });
      await publishSourceManifestRevision({
        repo: deps.repo,
        sourceId: id,
        manifestYaml: yaml,
      });
    } catch (error) {
      if (error instanceof InvalidSourceManifestError) {
        return reply.status(400).send({ detail: error.message });
      }
      if (error instanceof SourceActivationConflictError) {
        return reply.status(409).send({ detail: error.message });
      }
      throw error;
    }
    if (legacy.kind === "file") {
      try {
        const archived = await archiveLegacySourceManifest(
          legacy,
          deps.repo.reposDir,
          id,
        );
        if (archived && !archived.matchesObservedContent) {
          request.log.warn(
            { sourceId: id, backupPath: archived.backupPath },
            "Source manifest was saved; a concurrently changed legacy override was archived",
          );
        }
      } catch (error) {
        request.log.warn(
          {
            sourceId: id,
            legacyPath: legacy.legacyPath,
            reason: error instanceof Error ? error.message : String(error),
          },
          "Source manifest was saved, but its legacy override was retained",
        );
      }
    } else if (legacy.kind === "unsafe") {
      request.log.warn(
        { sourceId: id, legacyPath: legacy.legacyPath, reason: legacy.reason },
        "Source manifest was saved, but its unsafe legacy override was retained",
      );
    }
    return {
      source_id: id,
      path: MANIFEST_FILE,
      saved: true,
      yaml,
      document: { format: "print-partner-manifest-v2", version: 2, raw: yaml },
    };
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
        local_path: deps.repo.allowsUserSourceLocalPaths() ? row.localPath : null,
        content_available: true,
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

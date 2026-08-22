import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import * as yaml from "js-yaml";
import { importRulesForProject, scanRepo } from "@print-partner/domain";
import type { AppRepository } from "../db/repository.js";
import { safePathUnderRoot } from "../lib/secure-path.js";
import { loadKitCatalog } from "../services/kit-catalog.js";
import { applyStackPresetToProfile } from "../services/stack-preset.js";
import { loadKitManifest, saveKitManifest } from "../services/kit-manifest-store.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../data/manifests");

type RouteDeps = { repo: AppRepository };

const REGISTRY_STRING_FIELDS = ["slug", "target_repo", "title", "manifest_file"] as const;

export function parseRegistryIndex(raw: string): { entries: Array<Record<string, unknown>> } {
  const document = yaml.load(raw);
  if (!document || typeof document !== "object") {
    throw new Error("Manifest registry must be a YAML mapping");
  }
  const entries = (document as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) {
    throw new Error("Manifest registry must contain an entries array");
  }
  return {
    entries: entries.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Manifest registry entries[${index}] must be a mapping`);
      }
      const row = entry as Record<string, unknown>;
      for (const field of REGISTRY_STRING_FIELDS) {
        if (typeof row[field] !== "string" || !row[field].trim()) {
          throw new Error(`Manifest registry entries[${index}].${field} must be a string`);
        }
      }
      return { ...row };
    }),
  };
}

function loadRegistryIndex(): { entries: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(DATA_DIR, "registry-index.yaml"), "utf8");
  return parseRegistryIndex(raw);
}

export async function registerManifestRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/manifest-registry", async (request, reply) => {
    try {
      const { entries } = loadRegistryIndex();
      return { entries };
    } catch (error) {
      request.log.error({ err: error }, "Failed to load embedded manifest registry");
      return reply.status(500).send({ detail: "Manifest registry is unavailable" });
    }
  });

  app.get("/manifest-registry/:slug", async (request, reply) => {
    const slug = (request.params as { slug: string }).slug;
    const path = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)
      ? safePathUnderRoot(DATA_DIR, `${slug}.yaml`)
      : null;
    if (!path) return reply.status(404).send({ detail: "Manifest not found" });
    try {
      const yaml = readFileSync(path, "utf8");
      return { slug, yaml, document: { format: "yaml", raw: true } };
    } catch {
      return reply.status(404).send({ detail: "Manifest not found" });
    }
  });

  app.post("/manifest-registry/export-draft", async () => ({
    slug: "draft",
    manifest_yaml: "format: print-partner-manifest-v2\nversion: 2\n",
    meta_yaml: "title: Draft\n",
    issue_body: "Community manifest draft (web stub).",
  }));

  app.get("/manifest-templates", async () => ({
    templates: [
      { id: "minimal", label: "Minimal kit", category: "starter", available: "builtin" },
    ],
  }));

  app.get("/manifest-templates/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    return {
      id,
      label: "Minimal kit",
      category: "starter",
      yaml: "format: print-partner-manifest-v2\nversion: 2\nproject: Example\n",
      document: { format: "print-partner-manifest-v2", version: 2, project: "Example" },
    };
  });

  app.post("/sources/:id/manifest-draft", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row?.localPath) {
      return reply.status(400).send({ detail: "Source has no local_path — sync first" });
    }
    const rules = importRulesForProject(row.importedPaths);
    const scanned = scanRepo(row.localPath, "base", rules);
    if (!scanned.length) {
      return reply.status(400).send({ detail: "No STL files found in project" });
    }
    const yaml = [
      "format: print-partner-manifest-v2",
      "version: 2",
      `project: ${row.name}`,
      "parts:",
      ...scanned.slice(0, 50).map((p) => `  - match: ${p.matchKey}`),
    ].join("\n");
    return { project_id: id, part_count: scanned.length, yaml };
  });

  app.get("/kit-catalog", async () => loadKitCatalog());

  app.post("/plans/:id/apply-stack-preset", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { preset_id?: string };
    const presetId = String(body.preset_id ?? "").trim();
    if (!presetId) return reply.status(400).send({ detail: "preset_id is required" });
    if (!deps.repo.getOwnedProfileIdentity(id)) {
      return reply.status(404).send({ detail: "Profile not found" });
    }
    try {
      const result = applyStackPresetToProfile(deps.repo, id, presetId);
      const kit = loadKitManifest(deps.repo, id);
      kit.selections = result.selections;
      saveKitManifest(deps.repo, id, kit);
      return {
        profile_id: id,
        preset_id: result.preset_id,
        missing_sources: result.missing_sources,
        layers: result.layers,
        selections: result.selections,
        base_source_name: result.base_source_name,
        tag: result.tag,
        branch: result.branch,
        needs_sync: result.needs_sync,
      };
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });
}

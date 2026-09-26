import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import { referenceShareSchema } from "@print-partner/contracts";
import {
  ReferenceShareImportRefused,
  importReferenceShareBuild,
  inspectReferenceShare,
  type ReferenceShareMapping,
} from "../services/reference-share-import.js";
import {
  exportBuildReferenceShare,
  exportCollectionReferenceShare,
  referenceShareGitBundle,
  referenceShareWarnings,
  serializeReferenceShare,
} from "../services/reference-sharing.js";

function readMapping(value: unknown): ReferenceShareMapping | null {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const mapping: ReferenceShareMapping = {};
  for (const [key, projectId] of Object.entries(value)) {
    if (typeof projectId !== "number") return null;
    mapping[key] = projectId;
  }
  return mapping;
}

function readShareBody(body: unknown): { manifest: unknown; mapping: ReferenceShareMapping } | null {
  if (typeof body !== "object" || body == null || Array.isArray(body)) return null;
  const record = body as { manifest?: unknown; mapping?: unknown };
  const manifest = record.manifest ?? body;
  const mapping = readMapping(record.manifest == null ? {} : record.mapping);
  if (!mapping) return null;
  return { manifest, mapping };
}

export function registerReferenceSharingRoutes(app: FastifyInstance, repo: AppRepository): void {
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/plans/:id/reference-share",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ detail: "Invalid Build id" });
      if (!repo.getOwnedProfileIdentity(id)) return reply.code(404).send({ detail: "Build not found" });
      if (request.query.format != null && request.query.format !== "git") {
        return reply.code(400).send({ detail: "Supported download format: git" });
      }
      reply.header("Cache-Control", "no-store");
      let exported;
      try {
        exported = exportBuildReferenceShare(repo, id);
      } catch {
        return reply.code(409).send({ detail: "This Build cannot be represented safely as a reference manifest. Check its Source links and relative file paths." });
      }
      if (request.query.format === "git") {
        return reply.type("application/zip")
          .header("Content-Disposition", 'attachment; filename="printpartner-git-share.zip"')
          .send(Buffer.from(referenceShareGitBundle(exported.manifest)));
      }
      return exported;
    },
  );

  app.post("/reference-shares/validate", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const parsed = referenceShareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ detail: "Invalid references-only manifest: unsupported fields, version, paths, or source references." });
    reply.header("Cache-Control", "no-store");
    return { manifest: parsed.data, warnings: referenceShareWarnings(parsed.data) };
  });

  app.post("/reference-shares/git", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const parsed = referenceShareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ detail: "Invalid references-only manifest" });
    if (Buffer.byteLength(serializeReferenceShare(parsed.data), "utf8") > 4 * 1024 * 1024) {
      return reply.code(413).send({ detail: "Reference manifest exceeds the 4 MiB sharing limit" });
    }
    return reply.header("Cache-Control", "no-store").type("application/zip")
      .header("Content-Disposition", 'attachment; filename="printpartner-git-share.zip"')
      .send(Buffer.from(referenceShareGitBundle(parsed.data)));
  });

  app.post("/reference-shares/dependencies", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const body = readShareBody(request.body);
    const parsed = body ? referenceShareSchema.safeParse(body.manifest) : null;
    if (!body || !parsed?.success) {
      return reply.code(400).send({ detail: "Invalid references-only manifest: unsupported fields, version, paths, or source references." });
    }
    try {
      reply.header("Cache-Control", "no-store");
      return inspectReferenceShare(repo, parsed.data, body.mapping);
    } catch {
      return reply.code(400).send({ detail: "Reference mapping must name each manifest source at most once." });
    }
  });

  app.post("/reference-shares/imports", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const body = readShareBody(request.body);
    const parsed = body ? referenceShareSchema.safeParse(body.manifest) : null;
    if (!body || !parsed?.success) {
      return reply.code(400).send({ detail: "Invalid references-only manifest: unsupported fields, version, paths, or source references." });
    }
    try {
      const result = importReferenceShareBuild(repo, parsed.data, body.mapping);
      reply.header("Cache-Control", "no-store");
      return result;
    } catch (error) {
      if (error instanceof ReferenceShareImportRefused) {
        return reply.code(409).send({ detail: error.message, dependencies: error.dependencies });
      }
      return reply.code(400).send({ detail: "This reference manifest cannot be added to Builds." });
    }
  });

  app.post("/reference-shares/collections", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const body = request.body;
    if (typeof body !== "object" || body == null || Array.isArray(body)) {
      return reply.code(400).send({ detail: "Choose the Library Sources to share." });
    }
    const title = (body as { title?: unknown }).title;
    const sourceIds = (body as { source_ids?: unknown }).source_ids;
    if (typeof title !== "string" || !Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== "number")) {
      return reply.code(400).send({ detail: "Choose the Library Sources to share." });
    }
    try {
      const exported = exportCollectionReferenceShare(repo, title, sourceIds);
      reply.header("Cache-Control", "no-store");
      return exported;
    } catch (error) {
      const missing = error instanceof Error && error.message === "A selected Library Source is not available";
      return reply.code(missing ? 404 : 400).send({
        detail: missing ? "A selected Library Source is not in this Library." : "Choose the Library Sources to share.",
      });
    }
  });
}

import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import { referenceShareSchema } from "@print-partner/contracts";
import {
  exportBuildReferenceShare, referenceShareGitBundle, referenceShareWarnings, serializeReferenceShare,
} from "../services/reference-sharing.js";

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
}

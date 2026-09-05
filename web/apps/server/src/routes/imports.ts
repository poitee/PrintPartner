import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import {
  KIT_JSON_TOO_LARGE_DETAIL,
  KitJsonTooLargeError,
  parseKitBundleBuffer,
} from "../services/export-kit.js";
import {
  KIT_BUNDLE_UPLOAD_TOO_LARGE_DETAIL,
  MAX_KIT_BUNDLE_UPLOAD_BYTES,
  MAX_MULTIPART_FIELD_BYTES,
} from "../services/upload-limits.js";

type RouteDeps = { repo: Pick<AppRepository, "importKitBundle"> };

export async function registerImportRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const limited = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  /** Upload a shared .print-partner-kit.zip from the browser (web / Docker). */
  app.post("/imports/kit-bundle", limited, async (request, reply) => {
    let fileBuffer: Buffer | null = null;
    let filename: string | undefined;
    let newName: string | null = null;

    for await (const part of request.parts({
      limits: {
        fileSize: MAX_KIT_BUNDLE_UPLOAD_BYTES,
        files: 1,
        fields: 1,
        fieldSize: MAX_MULTIPART_FIELD_BYTES,
        parts: 2,
      },
    })) {
      if (part.type === "file" && part.fieldname === "file") {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(Buffer.from(chunk));
        }
        if (part.file.truncated) {
          return reply.status(413).send({
            detail: KIT_BUNDLE_UPLOAD_TOO_LARGE_DETAIL,
          });
        }
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename;
      } else if (part.type === "field" && part.fieldname === "new_name") {
        const value = part.value;
        newName = typeof value === "string" ? value.trim() || null : null;
      } else if (part.type === "file") {
        part.file.resume();
      }
    }

    if (!fileBuffer) {
      return reply.status(400).send({ detail: "Kit bundle file required" });
    }

    try {
      const data = parseKitBundleBuffer(fileBuffer, filename);
      return deps.repo.importKitBundle(data, newName);
    } catch (e) {
      if (e instanceof KitJsonTooLargeError) {
        return reply.status(413).send({ detail: KIT_JSON_TOO_LARGE_DETAIL });
      }
      return reply.status(400).send({
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

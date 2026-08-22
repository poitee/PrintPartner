import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import { parseKitBundleBuffer } from "../services/export-kit.js";

type RouteDeps = { repo: AppRepository };

export async function registerImportRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const limited = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  /** Upload a shared .print-partner-kit.zip from the browser (web / Docker). */
  app.post("/imports/kit-bundle", limited, async (request, reply) => {
    let fileBuffer: Buffer | null = null;
    let filename: string | undefined;
    let newName: string | null = null;

    for await (const part of request.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(Buffer.from(chunk));
        }
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename;
      } else if (part.type === "field" && part.fieldname === "new_name") {
        const value = part.value;
        newName = typeof value === "string" ? value.trim() || null : null;
      }
    }

    if (!fileBuffer) {
      return reply.status(400).send({ detail: "Kit bundle file required" });
    }

    try {
      const data = parseKitBundleBuffer(fileBuffer, filename);
      return deps.repo.importKitBundle(data, newName);
    } catch (e) {
      return reply.status(400).send({
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

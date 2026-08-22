import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Prefer packaged copies under data/legal (shipped with the server, works in Docker).
 * Fall back to monorepo / Docker /app root for LICENSE* at repository root.
 */
const DIR_CANDIDATES = [
  join(HERE, "../data/legal"),
  join(HERE, "../../src/data/legal"),
  join(HERE, "../../../../.."), // /app in Docker when licenses are copied there
];

const FILES: Record<string, string> = {
  summary: "LICENSE-SUMMARY.md",
  license: "LICENSE",
  attribution: "ATTRIBUTION.md",
  "third-party": "THIRD_PARTY_NOTICES.md",
};

function resolveLegalFile(file: string): string | null {
  for (const dir of DIR_CANDIDATES) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  return null;
}

export async function registerLegalRoutes(app: FastifyInstance): Promise<void> {
  for (const [name, file] of Object.entries(FILES)) {
    app.get(`/legal/${name}`, async (_request, reply) => {
      const path = resolveLegalFile(file);
      if (!path) {
        return reply.status(404).send({ detail: "Document not found" });
      }
      try {
        const text = readFileSync(path, "utf8");
        return reply.type("text/plain; charset=utf-8").send(text);
      } catch {
        return reply.status(404).send({ detail: "Document not found" });
      }
    });
  }
}

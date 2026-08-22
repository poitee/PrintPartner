import {
  createReadStream,
  existsSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import { fetchGithubReadme } from "../services/github-readme.js";
import {
  buildKnowledgeBundle,
  importKnowledgeBundle,
  parseKnowledgeBundle,
} from "../services/knowledge-bundle.js";
import {
  extractPdfText,
  readCachedPdfText,
} from "../services/pdf-text-extract.js";
import { readMarkdownDoc, walkSourceDocs } from "../services/source-docs-scan.js";
import { indexSourceDocsFromDisk } from "../services/source-docs-index.js";
import { sourcePdfTextStorage } from "../services/source-workspace.js";

const GITHUB_PAT_KEY = "github_pat";

type RouteDeps = { repo: AppRepository };

function safeUnderRoot(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  const absRoot = resolve(root);
  const dest = resolve(absRoot, normalized);
  if (dest !== absRoot && !dest.startsWith(`${absRoot}/`)) return null;
  return dest;
}

function ensureDocsIndexed(repo: AppRepository, sourceId: number, localPath: string): void {
  const existing = repo.listSourceDocs(sourceId);
  if (existing.length > 0) return;
  const onDisk = walkSourceDocs(localPath);
  if (onDisk.length === 0) return;
  indexSourceDocsFromDisk(repo, sourceId, localPath);
}

export async function registerSourceDocsRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/sources/:id/docs", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row) return reply.status(404).send({ detail: "Source not found" });

    if (row.localPath && existsSync(row.localPath)) {
      ensureDocsIndexed(deps.repo, id, row.localPath);
    }

    let docs = deps.repo.listSourceDocs(id).map((d) => ({
      path: d.path,
      title: d.title,
      kind: d.kind,
      size_bytes: d.size_bytes,
      extract_status: d.extract_status,
    }));

    // Disk fallback when DB empty (e.g. pre-migration sync).
    if (docs.length === 0 && row.localPath) {
      docs = walkSourceDocs(row.localPath).map((d) => ({
        path: d.path,
        title: d.title,
        kind: d.kind,
        size_bytes: d.sizeBytes,
        extract_status: d.kind === "pdf" ? "pending" : "na",
      }));
    }

    return {
      source_id: id,
      docs_url: row.docsUrl ?? row.url,
      docs,
    };
  });

  app.get("/sources/:id/docs/*", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row?.localPath) {
      return reply.status(404).send({ detail: "Source has no local_path — sync or import first" });
    }
    const docPath = ((request.params as { "*": string })["*"] ?? "").replace(/\\/g, "/");
    const download = String((request.query as { download?: string }).download ?? "") === "1";
    const abs = safeUnderRoot(row.localPath, docPath);
    if (!abs || !existsSync(abs)) {
      return reply.status(404).send({ detail: "Document not found" });
    }

    const lower = docPath.toLowerCase();
    if (lower.endsWith(".pdf")) {
      if (download) {
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="${basename(docPath).replace(/"/g, "")}"`,
          )
          .send(createReadStream(abs));
      }
      const pdfTextStorage = sourcePdfTextStorage(deps.repo, id, row.localPath);
      let cached = readCachedPdfText(row.localPath, docPath, pdfTextStorage);
      if (!cached) {
        const extracted = await extractPdfText(row.localPath, docPath, pdfTextStorage);
        if (extracted.status === "ready") {
          cached = { text: extracted.text, chunks: extracted.chunks, hash: extracted.hash };
          deps.repo.updateSourceDocExtract(id, docPath, {
            extractStatus: "ready",
            contentHash: extracted.hash,
            pageCount: extracted.pageCount,
            extractError: null,
          });
        } else {
          return reply.status(500).send({
            detail: extracted.error ?? "PDF text extraction failed",
            markdown: "",
          });
        }
      }
      return {
        path: docPath,
        kind: "pdf",
        markdown: cached.text,
        download_url: `/sources/${id}/docs/${docPath}?download=1`,
      };
    }

    const text = readMarkdownDoc(row.localPath, docPath);
    if (text == null) return reply.status(404).send({ detail: "Document not found" });
    return { path: docPath, kind: lower.endsWith(".md") ? "md" : "file", markdown: text };
  });

  app.get("/sources/:id/readme", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row) return reply.status(404).send({ detail: "Source not found" });
    const live = String((request.query as { live?: string }).live ?? "") === "1";
    const token = deps.repo.getSetting(GITHUB_PAT_KEY);
    const result = await fetchGithubReadme({
      url: row.url,
      branch: row.branch,
      tag: row.tag,
      token,
      localPath: row.localPath,
      live,
    });
    return {
      source_id: id,
      markdown: result.markdown,
      source: result.source,
      cached: result.cached,
      path: result.path,
    };
  });

  app.get("/sources/:id/notes", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getSource(id)) return reply.status(404).send({ detail: "Source not found" });
    const profileRaw = (request.query as { profile_id?: string }).profile_id;
    const profileId =
      profileRaw != null && profileRaw !== "" ? Number(profileRaw) : undefined;
    const notes = deps.repo.listSourceNotes(
      id,
      profileId != null && Number.isFinite(profileId) ? profileId : undefined,
    );
    return { source_id: id, notes };
  });

  app.post("/sources/:id/notes", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getSource(id)) return reply.status(404).send({ detail: "Source not found" });
    const body = request.body as {
      title?: string;
      body_markdown?: string;
      profile_id?: number | null;
    };
    const markdown = String(body.body_markdown ?? "");
    if (!markdown.trim()) {
      return reply.status(400).send({ detail: "body_markdown is required" });
    }
    const note = deps.repo.createSourceNote({
      projectId: id,
      title: body.title,
      bodyMarkdown: markdown,
      profileId: body.profile_id ?? null,
    });
    return reply.status(201).send(note);
  });

  app.patch("/sources/:id/notes/:noteId", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const noteId = Number((request.params as { noteId: string }).noteId);
    const existing = deps.repo.getSourceNote(noteId);
    if (!existing || existing.project_id !== id) {
      return reply.status(404).send({ detail: "Note not found" });
    }
    const body = request.body as {
      title?: string;
      body_markdown?: string;
      profile_id?: number | null;
    };
    try {
      const updated = deps.repo.updateSourceNote(noteId, {
        title: body.title,
        bodyMarkdown: body.body_markdown,
        profileId: body.profile_id,
      });
      return updated;
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/sources/:id/notes/:noteId", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const noteId = Number((request.params as { noteId: string }).noteId);
    const existing = deps.repo.getSourceNote(noteId);
    if (!existing || existing.project_id !== id) {
      return reply.status(404).send({ detail: "Note not found" });
    }
    deps.repo.deleteSourceNote(noteId);
    return reply.status(204).send();
  });

  app.get("/sources/:id/knowledge-bundle", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      return buildKnowledgeBundle(deps.repo, id);
    } catch (e) {
      return reply.status(404).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/sources/:id/knowledge-bundle/import", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getSource(id)) return reply.status(404).send({ detail: "Source not found" });
    try {
      const bundle = parseKnowledgeBundle(request.body);
      const result = importKnowledgeBundle(deps.repo, id, bundle);
      return { ok: true, ...result };
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });
}

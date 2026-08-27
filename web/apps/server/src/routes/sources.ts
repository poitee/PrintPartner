import { basename, dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  buildStlTreePayload,
  DEFAULT_STL_SEARCH_LIMIT,
  searchSourceStls,
} from "@print-partner/domain";
import { normalizeCategoryPath } from "@print-partner/contracts";
import type { JobSnapshot } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import {
  createReadStreamUnderRoot,
  openRepoStlMeshStream,
  openStlThumbStream,
} from "../lib/secure-path.js";
import { listGithubBranches, listGithubTags, syncGithubSource } from "../services/github-sync.js";
import { writeUploadedZip, writeUploadedFiles, finalizeUploadedSource } from "../services/archive-import.js";
import { PLACEHOLDER_PNG } from "../lib/thumbnails.js";
import { importReposTxt, parseReposTxtText } from "../services/repos-txt.js";
import { coverMediaType, ensureSourceCover } from "../lib/source-cover.js";
import { toCoverProject } from "./source-cover-route-model.js";
import {
  extractPendingPdfsForSource,
  indexSourceDocsFromDisk,
} from "../services/source-docs-index.js";
import { PDF_BG_EXTRACT_BYTES } from "../services/pdf-text-extract.js";
import { sourcePdfTextStorage } from "../services/source-workspace.js";
import { publishLocalSourceWorkingTree } from "../services/local-source-revision.js";
import { scanSourceArtifacts } from "../services/source-artifacts.js";

const GITHUB_PAT_KEY = "github_pat";

const MESH_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_SOURCE_DOCS_MAX_BYTES = 1024 * 1024 * 1024;

type RouteDeps = {
  repo: AppRepository;
  reposDir: string;
  sourcesDir: string;
  thumbsDir: string;
  coversDir: string;
  jobs?: import("./jobs.js").InProcessJobRunner;
};

async function prefetchSourceCover(deps: RouteDeps, sourceId: number): Promise<void> {
  const row = deps.repo.getProjectRow(sourceId);
  if (!row) return;
  try {
    await ensureSourceCover(deps.coversDir, toCoverProject(row));
  } catch {
    /* cover is best-effort */
  }
}

export async function registerSourceRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/sources", async () => ({ sources: deps.repo.listSources() }));

  app.get("/sources/github-branches", async (request, reply) => {
    const url = (request.query as { url?: string }).url ?? "";
    if (!url.trim()) {
      return reply.status(400).send({ detail: "url query parameter is required" });
    }
    try {
      const token = deps.repo.getSetting(GITHUB_PAT_KEY);
      return await listGithubBranches(url, token);
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/sources/github-tags", async (request, reply) => {
    const url = (request.query as { url?: string }).url ?? "";
    if (!url.trim()) {
      return reply.status(400).send({ detail: "url query parameter is required" });
    }
    try {
      const token = deps.repo.getSetting(GITHUB_PAT_KEY);
      return await listGithubTags(url, token);
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/sources/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const source = deps.repo.getSource(id);
    if (!source) return reply.status(404).send({ detail: "Source not found" });
    return source;
  });

  app.post("/sources", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const sourceKind = body.source_kind != null ? String(body.source_kind) : undefined;
      if (sourceKind === "printables" || sourceKind === "makerworld") {
        const modelUrl = body.url != null ? String(body.url).trim() : "";
        if (!modelUrl) {
          return reply.status(400).send({
            detail: `A ${sourceKind} model URL is required. Download the archive from the site and upload it after creating the source.`,
          });
        }
      }
      const newSource = deps.repo.createSource({
        name: String(body.name ?? ""),
        url: body.url != null ? String(body.url) : undefined,
        branch: body.branch != null ? String(body.branch) : undefined,
        tag: body.tag != null ? String(body.tag) : undefined,
        source_kind: body.source_kind != null ? String(body.source_kind) : undefined,
        role: body.role != null ? String(body.role) : undefined,
        local_path: body.local_path != null ? String(body.local_path) : undefined,
        metadata:
          body.metadata && typeof body.metadata === "object"
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      });
      // Kick off auto-sync for new GitHub/git source (best-effort, non-blocking)
      const kind = (body.source_kind ?? "github").toString().toLowerCase();
      if (kind === "github" || kind === "git") {
        try {
          if (deps.jobs) {
            void deps.jobs.start("sync", { project_ids: [newSource.id] }, request.tenantId);
          }
        } catch { /* best effort */ }
      }
      return newSource;
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.patch("/sources/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    try {
      return deps.repo.updateSource(id, {
        name: body.name != null ? String(body.name) : undefined,
        url: body.url != null ? String(body.url) : undefined,
        branch: body.branch != null ? String(body.branch) : undefined,
        tag: body.tag !== undefined ? (body.tag != null ? String(body.tag) : null) : undefined,
        source_kind: body.source_kind != null ? String(body.source_kind) : undefined,
        role: body.role != null ? String(body.role) : undefined,
        local_path: body.local_path != null ? String(body.local_path) : undefined,
        metadata:
          body.metadata && typeof body.metadata === "object"
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(msg.includes("not found") ? 404 : 400).send({ detail: msg });
    }
  });

  app.delete("/sources/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!deps.repo.getSource(id)) return reply.status(404).send({ detail: "Source not found" });
    deps.repo.deleteSource(id);
    return reply.status(204).send();
  });

  // Bulk category assignment — apply one category (or Uncategorised) to many
  // sources in a single request. Used by the Library multi-select bulk bar so
  // 25+ repos don't need one PATCH round-trip each.
  app.post("/sources/bulk-category", async (request, reply) => {
    const body = request.body as { source_ids?: unknown; category?: unknown };
    const rawIds = Array.isArray(body.source_ids) ? body.source_ids : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n)),
      ),
    );
    if (ids.length === 0) {
      return reply.status(400).send({ detail: "source_ids must be a non-empty array" });
    }
    // Category values are "/"-separated paths ("Printers/Frame"); canonicalize
    // spacing so drag-drop and typed input land in the same bucket.
    const category =
      typeof body.category === "string"
        ? normalizeCategoryPath(body.category)
        : body.category === null
          ? null
          : "";
    const results: Array<{ source_id: number; ok: boolean; detail?: string }> = [];
    const updated: Array<ReturnType<typeof deps.repo.getSource>> = [];
    for (const id of ids) {
      try {
        const source = deps.repo.updateSource(id, {
          metadata: { category: category == null || category === "" ? "" : category },
        });
        results.push({ source_id: id, ok: true });
        updated.push(source);
      } catch (e) {
        results.push({
          source_id: id,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return {
      updated: updated.filter((s): s is NonNullable<typeof s> => s != null),
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });

  app.get("/sources/:id/import-rules", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row) return reply.status(404).send({ detail: "Source not found" });
    const { parseImportRulesJson } = await import("@print-partner/domain");
    const rules = parseImportRulesJson(row.importedPaths);
    return {
      rules: rules ?? [],
      legacy_import_all: rules === null,
    };
  });

  app.put("/sources/:id/import-rules", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { rules?: string[] };
    try {
      const result = deps.repo.updateImportRules(id, body.rules ?? []);
      request.log.info(
        { sourceId: id, ruleCount: result.rules.length },
        "import-rules saved",
      );
      return result;
    } catch (e) {
      return reply.status(404).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/sources/:id/upload-zip", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row) return reply.status(404).send({ detail: "Source not found" });
    const data = await request.file();
    if (!data) return reply.status(400).send({ detail: "ZIP file required" });
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    let extractDir: string;
    try {
      extractDir = writeUploadedZip(buffer, deps.sourcesDir, id);
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
    const { suggestedImportRules, stlCount } = finalizeUploadedSource(extractDir);
    const existingRules = deps.repo.getProjectRow(id)?.importedPaths;
    const hasRules =
      existingRules != null &&
      existingRules.trim() !== "" &&
      existingRules.trim() !== "[]";
    if (!hasRules && suggestedImportRules.length > 0) {
      deps.repo.updateImportRules(id, suggestedImportRules);
    }
    let updated;
    try {
      updated = await publishLocalSourceWorkingTree({
        repo: deps.repo,
        reposDir: deps.reposDir,
        sourceId: id,
        workingTree: extractDir,
      });
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
    indexSourceDocsFromDisk(deps.repo, id, updated.local_path ?? extractDir);
    void prefetchSourceCover(deps, id);
    return {
      ...updated,
      imported_files: buffer.length,
      stl_count: stlCount,
      artifacts: scanSourceArtifacts(updated.local_path ?? extractDir),
      suggested_import_rules: suggestedImportRules,
    };
  });

  app.post("/sources/:id/upload-files", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row) return reply.status(404).send({ detail: "Source not found" });

    const uploads: Array<{ relativePath: string; buffer: Buffer }> = [];
    let relativePaths: string[] = [];
    for await (const part of request.parts({ limits: { files: 100, parts: 101 } })) {
      if (part.type === "field" && part.fieldname === "relative_paths") {
        const value = await part.value;
        try {
          const parsed = JSON.parse(String(value)) as unknown;
          if (Array.isArray(parsed)) {
            relativePaths = parsed.map((entry) => String(entry)).filter(Boolean);
          }
        } catch {
          relativePaths = [];
        }
        continue;
      }
      if (part.type !== "file" || part.fieldname !== "files") continue;
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) {
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      uploads.push({
        relativePath: (part.filename || "").replace(/\\/g, "/"),
        buffer,
      });
    }
    for (let i = 0; i < uploads.length; i += 1) {
      const fromClient = relativePaths[i]?.trim();
      const fromFilename = uploads[i]!.relativePath.trim();
      uploads[i]!.relativePath =
        fromClient ||
        fromFilename ||
        `upload-${i + 1}.stl`;
    }
    if (!uploads.length) {
      return reply.status(400).send({ detail: "At least one file is required" });
    }

    let result;
    try {
      result = writeUploadedFiles(uploads, deps.sourcesDir, id);
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }

    const existingRules = deps.repo.getProjectRow(id)?.importedPaths;
    const hasRules =
      existingRules != null &&
      existingRules.trim() !== "" &&
      existingRules.trim() !== "[]";
    if (!hasRules && result.suggestedImportRules.length > 0) {
      deps.repo.updateImportRules(id, result.suggestedImportRules);
    }

    let updated;
    try {
      updated = await publishLocalSourceWorkingTree({
        repo: deps.repo,
        reposDir: deps.reposDir,
        sourceId: id,
        workingTree: result.extractDir,
      });
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
    indexSourceDocsFromDisk(deps.repo, id, updated.local_path ?? result.extractDir);
    void prefetchSourceCover(deps, id);
    return {
      ...updated,
      imported_files: result.fileCount,
      stl_count: result.stlCount,
      artifacts: scanSourceArtifacts(updated.local_path ?? result.extractDir),
      suggested_import_rules: result.suggestedImportRules,
    };
  });

  app.get("/sources/:id/has-manifest", async () => ({
    has_manifest: false,
    manifest_kind: null,
  }));

  app.get("/sources/:id/cover", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row) return reply.status(404).send({ detail: "Source not found" });
    const coverRel = `source_${id}.img`;
    const ready = await ensureSourceCover(deps.coversDir, toCoverProject(row));
    // 204, not 404: most sources have no cover, and the Library probes this
    // route for every card — a 404 would log a console error per card.
    if (!ready) return reply.status(204).send();
    const stream = createReadStreamUnderRoot(deps.coversDir, coverRel);
    if (!stream) return reply.status(204).send();
    return reply.header("Content-Type", coverMediaType(coverRel)).send(stream);
  });

  app.get("/sources/stl-search", async (request) => {
    const query = request.query as { q?: string; limit?: string };
    const limit = query.limit ? Number(query.limit) : DEFAULT_STL_SEARCH_LIMIT;
    const sources = deps.repo.listSources().map((s) => {
      const row = deps.repo.getProjectRow(s.id);
      return {
        id: s.id,
        name: s.name,
        localPath: row?.localPath ?? s.local_path,
        category: s.category,
      };
    });
    return searchSourceStls(sources, query.q ?? "", limit);
  });

  app.get("/sources/maintenance", async () => ({
    no_manifest: [],
    catalog_orphans: [],
    empty_categories: [],
    drift: [],
  }));

  app.post("/sources/import-repos-txt", async (request, reply) => {
    // Server-side file paths are no longer accepted here; the SPA uploads text.
    const body = request.body as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) {
      return reply.status(400).send({ detail: "text is required" });
    }
    if (!parseReposTxtText(text).length) {
      return reply.status(400).send({ detail: "No valid repository lines found" });
    }
    try {
      return importReposTxt(deps.repo, text);
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/sources/:id/stl-tree", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = deps.repo.getProjectRow(id);
    if (!row) return reply.status(404).send({ detail: "Source not found" });
    if (!row.localPath) {
      return reply.status(400).send({ detail: "Source has no local_path — sync first" });
    }
    const payload = buildStlTreePayload(row.localPath, row.importedPaths);
    return { project_id: id, ...payload };
  });

  app.get("/sources/:id/stl/*", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const relEncoded = (request.params as { "*": string })["*"] ?? "";
    const segments = relEncoded.split("/").filter(Boolean);
    if (segments.length < 2) {
      return reply.status(404).send({ detail: "Expected …/mesh or …/preview" });
    }
    const action = segments.pop()!;
    const relativePath = decodeURIComponent(segments.join("/"));
    if (
      !relativePath ||
      relativePath.includes("..") ||
      relativePath.includes("\0") ||
      !relativePath.toLowerCase().endsWith(".stl")
    ) {
      return reply.status(400).send({ detail: "Invalid STL path" });
    }
    if (action !== "mesh" && action !== "preview") {
      return reply.status(404).send({ detail: "Unknown STL action" });
    }
    const row = deps.repo.getProjectRow(id);
    if (!row?.localPath) return reply.status(404).send({ detail: "Source not found" });
    return serveSourceStl(deps, reply, row.localPath, relativePath, action);
  });
}

function serveSourceStl(
  deps: RouteDeps,
  reply: import("fastify").FastifyReply,
  repoRoot: string,
  relativePath: string,
  action: string,
) {
  if (action === "mesh") {
    const stream = openRepoStlMeshStream(repoRoot, relativePath, MESH_MAX_BYTES);
    if (!stream) {
      return reply.status(404).send({ detail: "STL not readable" });
    }
    const name = basename(relativePath);
    return reply
      .header("Content-Type", "model/stl")
      .header("Content-Disposition", `inline; filename="${name}"`)
      .send(stream);
  }
  const preview = openStlThumbStream(deps.thumbsDir, repoRoot, relativePath, "preview");
  if (preview) {
    return reply.header("Content-Type", "image/png").send(preview);
  }
  const thumb = openStlThumbStream(deps.thumbsDir, repoRoot, relativePath, "thumb");
  if (thumb) {
    return reply.header("Content-Type", "image/png").send(thumb);
  }
  return reply.header("Content-Type", "image/png").send(PLACEHOLDER_PNG);
}

export async function syncProjectById(
  repo: AppRepository,
  reposDir: string,
  projectId: number,
  coversDir = join(dirname(reposDir), "covers"),
  options?: {
    maxDocsBytes?: number;
    onProgress?: (event: Partial<JobSnapshot>) => void;
    /** When set, enqueue PDF extraction as a follow-up job instead of inline. */
    enqueuePdfExtract?: (projectId: number) => Promise<string | void>;
  },
): Promise<{
  stl_count: number;
  downloaded: number;
  doc_count: number;
  docs_downloaded: number;
  pdf_extract_job_id?: string;
  postprocess_warning?: string;
}> {
  const row = repo.getProjectRow(projectId);
  if (!row) throw new Error("Source not found");
  const token = repo.getSetting(GITHUB_PAT_KEY);
  const maxDocsBytes = options?.maxDocsBytes ?? DEFAULT_SOURCE_DOCS_MAX_BYTES;

  if (row.sourceKind === "github" || row.sourceType === "git") {
    const result = await syncGithubSource({
      url: row.url,
      branch: row.branch ?? "main",
      reposDir,
      sourceId: projectId,
      token,
      options: {
        maxStlFiles: 500,
        tag: row.tag,
        maxDocsBytes,
        onProgress: (p) => {
          const base = p.phase === "docs" ? 55 : 15;
          const span = p.phase === "docs" ? 35 : 40;
          const frac = p.total > 0 ? p.current / p.total : 0;
          options?.onProgress?.({
            message: p.message ?? `Syncing ${p.phase}`,
            progress: Math.min(95, Math.round(base + span * frac)),
          });
        },
      },
    });
    const revision = repo.recordSourceRevision({
      sourceId: projectId,
      upstreamRevisionKey: result.commitSha,
      manifestDigest: result.snapshot.manifestDigest,
      snapshotLocator: result.snapshot.snapshotLocator,
      syncedAt: new Date().toISOString(),
      completeness: "complete",
    });
    const activated = repo.activateSourceRevision({
      sourceId: projectId,
      revisionId: revision.id,
      observed: row,
    });
    repo.markSourceRevisionCurrent(projectId, revision.id);
    const activePath = activated.local_path;
    if (!activePath) throw new Error("Activated Source revision has no local path");

    let indexed = { doc_count: 0, pending_pdfs: 0 };
    let pdf_extract_job_id: string | undefined;
    let postprocess_warning: string | undefined;
    try {
      indexed = indexSourceDocsFromDisk(repo, projectId, activePath, result.docPaths);
      const pdfTextStorage = sourcePdfTextStorage(repo, projectId, activePath);

      // Eagerly extract small PDFs; large ones go to a background job.
      const docs = repo.listSourceDocs(projectId);
      const smallPdfs = docs.filter(
        (d) => d.kind === "pdf" && d.size_bytes < PDF_BG_EXTRACT_BYTES && d.extract_status !== "ready",
      );
      const largePdfs = docs.filter(
        (d) => d.kind === "pdf" && d.size_bytes >= PDF_BG_EXTRACT_BYTES,
      );
      if (smallPdfs.length > 0) {
        options?.onProgress?.({ message: "Extracting PDF text…", progress: 92 });
        await extractPendingPdfsForSource(repo, projectId, activePath, {
          ...pdfTextStorage,
          maxSizeBytes: PDF_BG_EXTRACT_BYTES - 1,
          onProgress: (msg, progress) =>
            options?.onProgress?.({ message: msg, progress: 90 + Math.round(progress * 0.08) }),
        });
      }

      if (largePdfs.length > 0 && options?.enqueuePdfExtract) {
        const jobId = await options.enqueuePdfExtract(projectId);
        if (jobId) pdf_extract_job_id = jobId;
      } else if (largePdfs.length > 0) {
        options?.onProgress?.({ message: "Extracting large PDF manuals…", progress: 93 });
        await extractPendingPdfsForSource(repo, projectId, activePath, {
          ...pdfTextStorage,
          minSizeBytes: PDF_BG_EXTRACT_BYTES,
          onProgress: (msg, progress) =>
            options?.onProgress?.({ message: msg, progress: 90 + Math.round(progress * 0.08) }),
        });
      }
    } catch (error) {
      postprocess_warning = error instanceof Error ? error.message : String(error);
    }

    const syncedRow = repo.getProjectRow(projectId);
    if (syncedRow) {
      try {
        await ensureSourceCover(coversDir, toCoverProject(syncedRow));
      } catch {
        /* cover is best-effort */
      }
    }
    return {
      stl_count: result.stlPaths.length,
      downloaded: result.downloaded,
      doc_count: indexed.doc_count,
      docs_downloaded: result.docsDownloaded,
      pdf_extract_job_id,
      postprocess_warning,
    };
  }

  // Zip/local: index whatever docs already landed on disk.
  if (row.localPath) {
    const indexed = indexSourceDocsFromDisk(repo, projectId, row.localPath);
    repo.markSourceSynced(projectId, row.lastCommitSha);
    return {
      stl_count: 0,
      downloaded: 0,
      doc_count: indexed.doc_count,
      docs_downloaded: 0,
    };
  }

  repo.markSourceSynced(projectId, row.lastCommitSha);
  return { stl_count: 0, downloaded: 0, doc_count: 0, docs_downloaded: 0 };
}

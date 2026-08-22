import { join } from "node:path";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  DATE_FORMAT_DEFAULT,
  JOB_KINDS,
  parseAcceptedPlateId,
  parseDirectExportJobResult,
  parseStartDirectExportRequest,
  type AcceptedPlateExportJobResult,
  type DateFormatId,
  type JobSnapshot,
  type JobKind,
  type StartAcceptedPlateExportRequest,
  type StartDirectExportRequest,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { exportDownloadKey, tenantExportDirectory } from "../lib/secure-path.js";
import { syncProjectById } from "./sources.js";
import {
  exportStlPackJobMessage,
  materializeAcceptedStlBundle,
  type StlPackGroupBy,
} from "../services/export-stl-pack.js";
import { materializeAcceptedChecklistHtml } from "../services/export-html.js";
import { buildKitBundleData, writeKitBundleData } from "../services/export-kit.js";
import { checkAllSourceUpdates } from "../services/source-update-check.js";
import { dispatchWebhooks } from "../services/webhook-store.js";
import { getRequestTenantId, tenantStorage } from "../middleware/tenant-context.js";
import { extractPendingPdfsForSource } from "../services/source-docs-index.js";
import { sourcePdfTextStorage } from "../services/source-workspace.js";
import { parseCheckoffUnits, parseUnlabeledNames } from "../services/printer-checkoff.js";
import { sendProblem } from "../lib/api-error.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { loadFleet } from "../services/printer-fleet.js";
import { parsePrinterUploadMultipart } from "../services/printer-upload-multipart.js";
import { runPrinterUploadJob } from "../services/printer-upload-job.js";
import { reconcileSendQueueJobResult } from "../services/printer-send-queue.js";
import { getLogger } from "../services/logger.js";
import {
  ACCEPTED_PLATE_EXPORT_LIMITS,
  materializeAcceptedPlateExport,
  type MaterializeAcceptedPlateExportResult,
} from "../services/accepted-plate-export-delivery.js";
import {
  AcceptedOperationalExportPublicError,
  acceptedOperationalExportPublicError,
  captureAcceptedOperationalExport,
} from "../services/accepted-operational-export.js";
import {
  materializeDirectExport3mf,
  type MaterializeDirectExport3mfResult,
} from "../services/accepted-direct-export-3mf.js";

export type JobHandler = (
  jobId: string,
  emit: (event: Partial<JobSnapshot>) => void,
) => Promise<Record<string, unknown>>;

export type JobRunnerDeps = {
  getRepo: () => AppRepository;
  reposDir: string;
  exportsDir: string;
  dataDir: string;
  sourceDocsMaxBytes?: number;
};

export type JobListFilters = {
  status?: string;
  since?: string;
  profile_id?: number;
};

type JobMeta = {
  payload: Record<string, unknown>;
  tenantId: string;
  updatedAt: number;
};

export const COMPLETED_JOB_MAX = 1_000;
export const COMPLETED_JOB_GLOBAL_MAX = 10_000;
export const COMPLETED_JOB_RETENTION_MS = 24 * 60 * 60 * 1_000;
const EMPTY_TENANT_JOB_BUCKET = Symbol("empty-tenant-job-bucket");
const STARTABLE_JOB_KINDS = new Set<string>(JOB_KINDS);

const ACCEPTED_PLATE_EXPORT_ERRORS = {
  plate_revision_changed: "Plate layout changed. Refresh and export again.",
  unplaced_units: "Arrange every Required unit on a Plate before exporting.",
  accepted_state: "Accepted Plan state is unavailable. Refresh the Plan.",
  artifact: "A verified accepted artifact is unavailable.",
  limit: "Accepted Plate export exceeds the configured limit.",
  transaction: "Accepted Plate export is temporarily unavailable.",
  output: "The stored export for this Plate revision failed integrity verification.",
  unexpected: "Accepted Plate export failed.",
} as const;

class AcceptedPlateExportPublicError extends Error {}

function positiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acceptedPlateExportError(result: Exclude<
  MaterializeAcceptedPlateExportResult,
  { readonly kind: "materialized" }
>): string {
  switch (result.kind) {
    case "plate_revision_changed":
      return ACCEPTED_PLATE_EXPORT_ERRORS.plate_revision_changed;
    case "unplaced_units":
      return ACCEPTED_PLATE_EXPORT_ERRORS.unplaced_units;
    case "empty_plan":
    case "plates_not_published":
    case "stale_accepted_plan":
    case "accepted_state_unavailable":
    case "profile_not_found":
      return ACCEPTED_PLATE_EXPORT_ERRORS.accepted_state;
    case "artifact_unavailable":
    case "invalid_stl":
    case "artifact_geometry_mismatch":
      return ACCEPTED_PLATE_EXPORT_ERRORS.artifact;
    case "limit_exceeded":
      return ACCEPTED_PLATE_EXPORT_ERRORS.limit;
    case "transaction_unavailable":
      return ACCEPTED_PLATE_EXPORT_ERRORS.transaction;
    case "output_conflict":
      return ACCEPTED_PLATE_EXPORT_ERRORS.output;
  }
}

function directExportError(result: Exclude<
  MaterializeDirectExport3mfResult,
  { readonly kind: "materialized" }
>): string {
  switch (result.kind) {
    case "empty_plan":
    case "accepted_state_unavailable":
    case "profile_not_found":
      return ACCEPTED_PLATE_EXPORT_ERRORS.accepted_state;
    case "unknown_token":
      return "A selected Required unit is not on this Plan.";
    case "artifact_unavailable":
    case "invalid_stl":
    case "artifact_geometry_mismatch":
      return ACCEPTED_PLATE_EXPORT_ERRORS.artifact;
    case "limit_exceeded":
      return "Direct export exceeds the configured limit.";
    case "output_failure":
      return "Direct export could not be published safely.";
  }
}

export type JobRunnerOptions = {
  completedJobMax?: number;
  completedJobGlobalMax?: number;
  completedJobRetentionMs?: number;
};

export class InProcessJobRunner {
  private readonly jobs = new Map<string, JobSnapshot>();
  private readonly jobMeta = new Map<string, JobMeta>();
  private readonly listeners = new Map<string, Set<(event: JobSnapshot) => void>>();
  private readonly completedJobMax: number;
  private readonly completedJobGlobalMax: number;
  private readonly completedJobRetentionMs: number;

  constructor(
    private readonly deps: JobRunnerDeps,
    options: JobRunnerOptions = {},
  ) {
    this.completedJobMax = Math.max(
      1,
      Math.trunc(options.completedJobMax ?? COMPLETED_JOB_MAX),
    );
    this.completedJobGlobalMax = Math.max(
      1,
      Math.trunc(options.completedJobGlobalMax ?? COMPLETED_JOB_GLOBAL_MAX),
    );
    this.completedJobRetentionMs = Math.max(
      1,
      Math.trunc(options.completedJobRetentionMs ?? COMPLETED_JOB_RETENTION_MS),
    );
  }

  private get repo(): AppRepository {
    return this.deps.getRepo();
  }

  /** Used by multipart job routes that need to persist artifacts before start(). */
  getExportsDir(tenantId = getRequestTenantId()): string {
    return tenantExportDirectory(this.deps.exportsDir, tenantId);
  }

  getRepo(): AppRepository {
    return this.deps.getRepo();
  }

  subscribe(
    jobId: string,
    tenantId: string,
    listener: (event: JobSnapshot) => void,
  ): (() => void) | null {
    if (!this.isOwnedBy(jobId, tenantId)) return null;
    const set = this.listeners.get(jobId) ?? new Set();
    set.add(listener);
    this.listeners.set(jobId, set);
    return () => {
      set.delete(listener);
    };
  }

  private isOwnedBy(jobId: string, tenantId: string): boolean {
    return this.jobMeta.get(jobId)?.tenantId === tenantId;
  }

  private isTerminal(snapshot: JobSnapshot): boolean {
    return (
      snapshot.status === "done" ||
      snapshot.status === "error" ||
      snapshot.status === "cancelled"
    );
  }

  private deleteJob(jobId: string): void {
    this.jobs.delete(jobId);
    this.jobMeta.delete(jobId);
    this.listeners.delete(jobId);
  }

  private pruneCompletedJobs(now = Date.now()): void {
    const completed = [...this.jobs.entries()]
      .filter(([, snapshot]) => this.isTerminal(snapshot))
      .map(([jobId]) => {
        const meta = this.jobMeta.get(jobId);
        return {
          jobId,
          tenantId: meta?.tenantId,
          updatedAt: meta?.updatedAt ?? 0,
        };
      })
      .sort((a, b) => a.updatedAt - b.updatedAt);

    for (const item of completed) {
      if (now - item.updatedAt >= this.completedJobRetentionMs) {
        this.deleteJob(item.jobId);
      }
    }

    const retainedByTenant = new Map<string | symbol, typeof completed>();
    for (const item of completed) {
      if (!this.jobs.has(item.jobId)) continue;
      const tenantBucket = item.tenantId || EMPTY_TENANT_JOB_BUCKET;
      const retained = retainedByTenant.get(tenantBucket) ?? [];
      retained.push(item);
      retainedByTenant.set(tenantBucket, retained);
    }
    for (const retained of retainedByTenant.values()) {
      while (retained.length > this.completedJobMax) {
        this.deleteJob(retained.shift()!.jobId);
      }
    }

    const retainedGlobally = completed.filter((item) => this.jobs.has(item.jobId));
    while (retainedGlobally.length > this.completedJobGlobalMax) {
      this.deleteJob(retainedGlobally.shift()!.jobId);
    }
  }

  private touchMeta(jobId: string): void {
    const meta = this.jobMeta.get(jobId);
    if (meta) meta.updatedAt = Date.now();
  }

  private emit(jobId: string, patch: Partial<JobSnapshot>): void {
    const snap = this.jobs.get(jobId);
    if (!snap) return;
    Object.assign(snap, patch);
    this.touchMeta(jobId);
    const event = { ...snap, updated_at: new Date().toISOString() } as JobSnapshot & {
      updated_at?: string;
    };
    for (const listener of this.listeners.get(jobId) ?? []) {
      listener(event);
    }
    if (event.status === "done" || event.status === "error") {
      void dispatchWebhooks(this.repo, event.status === "done" ? "job.done" : "job.error", {
        job_id: event.job_id,
        kind: event.kind,
        status: event.status,
        result: event.result,
        error: event.error,
      });
      // Fire plan.exported for any export job that completes successfully.
      const EXPORT_KINDS = new Set([
        "export-stl-pack",
        "export-checklist-html",
        "export-kit-bundle",
        "export-accepted-plate-3mf",
        "export-direct-3mf",
      ]);
      if (event.status === "done" && EXPORT_KINDS.has(event.kind)) {
        const meta = this.jobMeta.get(jobId);
        void dispatchWebhooks(this.repo, "plan.exported", {
          job_id: event.job_id,
          kind: event.kind,
          profile_id: meta?.payload.profile_id ?? null,
          download_url: (event.result as Record<string, unknown> | null)?.download_url ?? null,
        });
      }
      this.pruneCompletedJobs();
    }
  }

  async start(
    kind: JobKind,
    payload: Record<string, unknown>,
    tenantId = "default",
  ): Promise<string> {
    if (!STARTABLE_JOB_KINDS.has(kind)) {
      throw new Error(`Unsupported job kind: ${kind}`);
    }
    this.pruneCompletedJobs();
    const jobId = crypto.randomUUID();
    const snap: JobSnapshot = {
      job_id: jobId,
      kind,
      status: "pending",
      message: "Queued",
      progress: 0,
      result: null,
      error: null,
    };
    this.jobs.set(jobId, snap);
    this.jobMeta.set(jobId, {
      payload: { ...payload, _tenant_id: tenantId },
      tenantId,
      updatedAt: Date.now(),
    });
    // Defer so the HTTP response for job_id can flush before CPU-heavy sync work runs.
    setImmediate(() => {
      void this.runJob(jobId, kind, { ...payload, _tenant_id: tenantId });
    });
    return jobId;
  }

  listJobs(
    filters: JobListFilters = {},
    tenantId: string,
  ): Array<JobSnapshot & { updated_at?: string }> {
    this.pruneCompletedJobs();
    let items = [...this.jobs.entries()]
      .filter(([jobId]) => this.isOwnedBy(jobId, tenantId))
      .map(([jobId, snap]) => {
        const meta = this.jobMeta.get(jobId);
        return {
          ...snap,
          updated_at: meta ? new Date(meta.updatedAt).toISOString() : undefined,
        };
      });
    if (filters.status) {
      items = items.filter((j) => j.status === filters.status);
    }
    if (filters.since) {
      const sinceMs = Date.parse(filters.since);
      if (!Number.isNaN(sinceMs)) {
        items = items.filter((j) => {
          const ts = j.finished_at
            ? Date.parse(j.finished_at)
            : j.updated_at
              ? Date.parse(j.updated_at)
              : NaN;
          return !Number.isNaN(ts) && ts >= sinceMs;
        });
      }
    }
    if (filters.profile_id != null) {
      items = items.filter((j) => {
        const payload = this.jobMeta.get(j.job_id)?.payload;
        return Number(payload?.profile_id) === filters.profile_id;
      });
    }
    return items.sort((a, b) => {
      const ta = a.finished_at
        ? Date.parse(a.finished_at)
        : a.updated_at
          ? Date.parse(a.updated_at)
          : 0;
      const tb = b.finished_at
        ? Date.parse(b.finished_at)
        : b.updated_at
          ? Date.parse(b.updated_at)
          : 0;
      return tb - ta;
    });
  }

  private downloadUrlForPath(absolutePath: string): string | null {
    const key = exportDownloadKey(this.deps.dataDir, getRequestTenantId(), absolutePath);
    return key ? `/exports/${key}` : null;
  }

  private async runJob(jobId: string, kind: JobKind, payload: Record<string, unknown>): Promise<void> {
    const tenantId = String(payload._tenant_id ?? "default");
    await tenantStorage.run(tenantId, async () => {
      this.emit(jobId, { status: "running", message: "Running…", progress: 10 });
      try {
        let result: Record<string, unknown>;
        if (kind === "sync") {
          result = await this.runSync(jobId, payload);
        } else if (kind === "import-scan") {
          const projectId = Number(payload.project_id);
          result = await syncProjectById(this.repo, this.deps.reposDir, projectId, undefined, {
            maxDocsBytes: this.deps.sourceDocsMaxBytes,
            onProgress: (patch) => this.emit(jobId, patch),
            enqueuePdfExtract: (pid) =>
              this.start("extract-source-docs", { project_id: pid }, tenantId),
          });
        } else if (kind === "extract-source-docs") {
          result = await this.runExtractSourceDocs(jobId, payload);
        } else if (kind === "check-source-updates") {
          result = await checkAllSourceUpdates(this.repo);
        } else if (kind === "export-stl-pack") {
          result = await this.runExportStlPack(payload);
        } else if (kind === "export-checklist-html") {
          result = await this.runExportChecklistHtml(payload);
        } else if (kind === "export-kit-bundle") {
          result = await this.runExportKitBundle(payload);
        } else if (kind === "export-accepted-plate-3mf") {
          result = await this.runAcceptedPlateExport(payload);
        } else if (kind === "export-direct-3mf") {
          result = await this.runDirectExport3mf(payload);
        } else if (kind === "printer-upload") {
          result = await this.runPrinterUpload(jobId, payload);
        } else {
          const unsupported: never = kind;
          throw new Error(`Unsupported job kind: ${unsupported}`);
        }
        const doneMessage =
          kind === "export-stl-pack"
            ? exportStlPackJobMessage(result)
            : kind === "printer-upload" && typeof result.message === "string"
              ? result.message
              : kind === "sync" && Number(result.failed ?? 0) > 0
              ? `Synced ${result.synced ?? 0}, ${result.failed} failed — check Settings → GitHub PAT if rate-limited`
              : "Complete";
        this.emit(jobId, {
          status: "done",
          message: doneMessage,
          progress: 100,
          result,
          error: null,
          finished_at: new Date().toISOString(),
        });
        if (kind === "printer-upload") {
          reconcileSendQueueJobResult(this.repo, jobId, {
            ok: true,
            message: doneMessage,
          });
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        try {
          this.emit(jobId, {
            status: "error",
            message: errMsg,
            progress: 100,
            error: errMsg,
            result: null,
            finished_at: new Date().toISOString(),
          });
        } catch {
          // Best-effort: if the repo/db connection is already gone (e.g. test
          // teardown raced a still-running background job), there's nothing
          // more we can do to report the failure — swallow rather than
          // surface an unhandled rejection.
        }
        // Reconcile outside the emit try block so an emit failure cannot leave
        // a printer-upload stuck in "sending".
        if (kind === "printer-upload") {
          try {
            reconcileSendQueueJobResult(this.repo, jobId, {
              ok: false,
              message: errMsg,
            });
          } catch {
            // Same teardown race as above.
          }
        }
      }
    });
  }

  private async runSync(
    jobId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ids = Array.isArray(payload.project_ids)
      ? (payload.project_ids as number[])
      : this.repo.listProjectIds();
    const tenantId = String(payload._tenant_id ?? "default");
    const results: Array<Record<string, unknown>> = [];
    const failures: Array<{ project_id: number; name: string | null; error: string }> = [];
    const hasPat = Boolean(this.repo.getSetting("github_pat")?.trim());
    if (!hasPat && ids.length > 10) {
      this.emit(jobId, {
        message:
          "No GitHub PAT configured — unauthenticated API limit is 60/hour. Add a token in Settings → GitHub PAT for bulk sync.",
        progress: 2,
      });
    }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const row = this.repo.getProjectRow(id);
      this.emit(jobId, {
        message: `Syncing ${row?.name ?? `source ${id}`} (${i + 1}/${ids.length})`,
        progress: Math.round((i / Math.max(ids.length, 1)) * 90),
      });
      try {
        results.push({
          project_id: id,
          ...(await syncProjectById(this.repo, this.deps.reposDir, id, undefined, {
            maxDocsBytes: this.deps.sourceDocsMaxBytes,
            onProgress: (patch) => this.emit(jobId, patch),
            enqueuePdfExtract: (pid) =>
              this.start("extract-source-docs", { project_id: pid }, tenantId),
          })),
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const isRateLimit = /rate limit exceeded/i.test(errMsg);
        const friendly = isRateLimit
          ? `${errMsg} Add a GitHub PAT in Settings to raise the limit from 60/hour to 5,000/hour.`
          : errMsg;
        failures.push({ project_id: id, name: row?.name ?? null, error: friendly });
        if (isRateLimit) {
          // Remaining sources will also fail without a PAT — stop early.
          for (let j = i + 1; j < ids.length; j++) {
            const skipped = this.repo.getProjectRow(ids[j]!);
            failures.push({
              project_id: ids[j]!,
              name: skipped?.name ?? null,
              error: "Skipped — GitHub API rate limit exceeded. Add a PAT in Settings and retry.",
            });
          }
          break;
        }
        // Continue with other sources (bad branch / missing repo should not abort the whole batch).
        continue;
      }
    }
    if (results.length === 0 && failures.length > 0) {
      throw new Error(failures.map((f) => `${f.name ?? f.project_id}: ${f.error}`).join("; "));
    }
    return { synced: results.length, failed: failures.length, results, failures };
  }

  private async runExtractSourceDocs(
    jobId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const projectId = Number(payload.project_id);
    const row = this.repo.getProjectRow(projectId);
    if (!row?.localPath) throw new Error("Source has no local path");
    this.emit(jobId, { message: "Extracting PDF text…", progress: 15 });
    const pdfTextStorage = sourcePdfTextStorage(this.repo, projectId, row.localPath);
    const result = await extractPendingPdfsForSource(this.repo, projectId, row.localPath, {
      ...pdfTextStorage,
      onProgress: (msg, progress) => this.emit(jobId, { message: msg, progress }),
    });
    return { project_id: projectId, ...result };
  }

  private acceptedOperationalExportFailure(
    error: unknown,
    operation: "accepted_stl_export" | "accepted_checklist_export" | "accepted_kit_progress_export",
    profileId: number,
    revisionId?: number,
  ): never {
    if (error instanceof AcceptedOperationalExportPublicError) throw error;
    getLogger().log("error", "Accepted operational export failed unexpectedly", {
      operation,
      failure: "unexpected",
      profileId,
      ...(revisionId == null ? {} : { revisionId }),
    });
    throw new AcceptedOperationalExportPublicError("unexpected");
  }

  private async runExportStlPack(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const profileId = Number(payload.profile_id);
    let revisionId: number | undefined;
    try {
      const missingOnly = Boolean(payload.missing_only);
      const groupBy: StlPackGroupBy = payload.group_by === "color" ? "color" : "color_dir";
      const capture = captureAcceptedOperationalExport({ repository: this.repo, profileId });
      if (capture.kind !== "ready" && capture.kind !== "empty") {
        throw acceptedOperationalExportPublicError(capture);
      }
      revisionId = capture.kind === "ready" ? capture.export.basis.revisionId : undefined;
      const naming = this.repo.getGlobalNaming();
      const materialized = await materializeAcceptedStlBundle({
        capture,
        reposDir: this.deps.reposDir,
        tenantExportsDir: this.getExportsDir(),
        selection: missingOnly ? "missing" : "all",
        groupBy,
        roleOrder: naming.export_role_order,
      });
      if (materialized.kind === "limit_exceeded") {
        throw new AcceptedOperationalExportPublicError("export_limit_exceeded");
      }
      if (materialized.kind === "output_failure") {
        throw new AcceptedOperationalExportPublicError("export_output_failure");
      }
      const fileTotal = Object.values(materialized.fileCounts).reduce((a, b) => a + b, 0);
      const warnings = materialized.warnings.map(
        (warning) =>
          `A verified accepted STL is unavailable: ${warning.relativePath} (${warning.sourceLayer}).`,
      );
      return {
        root_path: materialized.rootPath,
        download_url: materialized.bundlePath
          ? this.downloadUrlForPath(materialized.bundlePath)
          : null,
        file_counts: materialized.fileCounts,
        zip_counts: materialized.fileCounts,
        warnings,
        missing_only: missingOnly,
        file_total: fileTotal,
        ...(materialized.basis
          ? {
              plan_version: materialized.basis.planVersion,
              revision_id: materialized.basis.revisionId,
            }
          : {}),
      };
    } catch (error) {
      return this.acceptedOperationalExportFailure(
        error,
        "accepted_stl_export",
        profileId,
        revisionId,
      );
    }
  }

  private async runExportChecklistHtml(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const profileId = Number(payload.profile_id);
    let revisionId: number | undefined;
    try {
      const capture = captureAcceptedOperationalExport({ repository: this.repo, profileId });
      if (capture.kind !== "ready" && capture.kind !== "empty") {
        throw acceptedOperationalExportPublicError(capture);
      }
      revisionId = capture.kind === "ready" ? capture.export.basis.revisionId : undefined;
      const dateFormat = (this.repo.getSetting("date_format") as DateFormatId | null) ?? DATE_FORMAT_DEFAULT;
      const materialized = materializeAcceptedChecklistHtml({
        capture,
        tenantExportsDir: this.getExportsDir(),
        thumbsDir: join(this.deps.dataDir, "thumbs"),
        dateFormat,
        generatedAt: new Date().toISOString(),
      });
      if (materialized.kind === "output_failure") {
        throw new AcceptedOperationalExportPublicError("export_output_failure");
      }
      return {
        path: materialized.path,
        download_url: this.downloadUrlForPath(materialized.path),
        part_count: materialized.partCount,
        thumb_count: materialized.thumbCount,
        ...(materialized.basis
          ? {
              plan_version: materialized.basis.planVersion,
              revision_id: materialized.basis.revisionId,
            }
          : {}),
      };
    } catch (error) {
      return this.acceptedOperationalExportFailure(
        error,
        "accepted_checklist_export",
        profileId,
        revisionId,
      );
    }
  }

  private async runExportKitBundle(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const profileId = Number(payload.profile_id);
    const includePrintProgress = Boolean(payload.include_print_progress);
    let revisionId: number | undefined;
    try {
      const accepted = includePrintProgress
        ? captureAcceptedOperationalExport({ repository: this.repo, profileId })
        : null;
      if (accepted && accepted.kind !== "ready" && accepted.kind !== "empty") {
        throw acceptedOperationalExportPublicError(accepted);
      }
      revisionId = accepted?.kind === "ready" ? accepted.export.basis.revisionId : undefined;
      const recipe = this.repo.readEditableKitRecipe(profileId);
      const data = buildKitBundleData({
        mode: accepted
          ? {
              kind: "accepted_progress",
              recipe,
              accepted: accepted.kind === "ready" ? accepted.export : null,
            }
          : { kind: "editable", recipe },
        exportedAt: new Date().toISOString(),
      });
      let path: string;
      try {
        path = writeKitBundleData({
          data,
          profileId: recipe.profile.id,
          profileName: recipe.profile.name,
          exportsDir: this.getExportsDir(),
        });
      } catch {
        throw new AcceptedOperationalExportPublicError("export_output_failure");
      }
      return {
        path,
        download_url: this.downloadUrlForPath(path),
        profile_id: profileId,
        ...(accepted?.kind === "ready"
          ? {
              plan_version: accepted.export.basis.planVersion,
              revision_id: accepted.export.basis.revisionId,
            }
          : {}),
      };
    } catch (error) {
      return this.acceptedOperationalExportFailure(
        error,
        "accepted_kit_progress_export",
        profileId,
        revisionId,
      );
    }
  }

  private async runAcceptedPlateExport(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const profileId = positiveSafeInteger(payload.profile_id);
    const expectedPlateRevisionId = positiveSafeInteger(payload.expected_plate_revision_id);
    const unexpectedFailure = (): never => {
      getLogger().log(
        "error",
        "Accepted Plate export failed unexpectedly",
        {
          operation: "accepted_plate_export",
          failure: "unexpected",
          profileId,
          expectedPlateRevisionId,
        },
      );
      throw new Error(ACCEPTED_PLATE_EXPORT_ERRORS.unexpected);
    };
    try {
      if (profileId == null || expectedPlateRevisionId == null) {
        throw new Error(ACCEPTED_PLATE_EXPORT_ERRORS.unexpected);
      }
      const materialized = await materializeAcceptedPlateExport({
        repository: this.repo,
        reposDir: this.deps.reposDir,
        tenantExportsDir: this.getExportsDir(),
        limits: ACCEPTED_PLATE_EXPORT_LIMITS,
      }, { profileId, expectedPlateRevisionId });
      if (materialized.kind !== "materialized") {
        throw new AcceptedPlateExportPublicError(acceptedPlateExportError(materialized));
      }
      const downloadUrl = (path: string): string => {
        const url = this.downloadUrlForPath(path);
        if (!url) throw new Error(ACCEPTED_PLATE_EXPORT_ERRORS.unexpected);
        return url;
      };
      const plates = materialized.plates.map((plate) => ({
        plate_id: parseAcceptedPlateId(plate.plateId),
        ordinal: plate.ordinal,
        filename: plate.filename,
        download_url: downloadUrl(plate.absolutePath),
      }));
      const solePlate = plates.length === 1 ? plates[0] : undefined;
      const result: AcceptedPlateExportJobResult = {
        format: "accepted-plate-export-job-v1",
        profile_id: profileId,
        basis: {
          profile_id: materialized.basis.profileId,
          plan_version: materialized.basis.planVersion,
          plan_revision_id: materialized.basis.revisionId,
          plan_revision_digest: materialized.basis.revisionDigest,
          required_unit_mapping_digest: materialized.basis.requiredUnitMappingDigest,
        },
        plate_revision_id: materialized.plateRevisionId,
        plate_revision_number: materialized.plateRevisionNumber,
        layout_digest: materialized.layoutDigest,
        download_url: solePlate?.download_url ?? downloadUrl(materialized.bundle.absolutePath),
        manifest_download_url: downloadUrl(materialized.manifest.absolutePath),
        bundle_download_url: downloadUrl(materialized.bundle.absolutePath),
        plates,
      };
      return result;
    } catch (error) {
      if (error instanceof AcceptedPlateExportPublicError) {
        throw error;
      }
      return unexpectedFailure();
    }
  }

  private async runDirectExport3mf(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const unexpectedFailure = (): never => {
      getLogger().log("error", "Direct export failed unexpectedly", {
        operation: "direct_export_3mf",
        failure: "unexpected",
        profileId: payload.profile_id,
      });
      throw new Error("Direct export failed.");
    };
    try {
      const command = parseStartDirectExportRequest({
        profile_id: payload.profile_id,
        tokens: payload.tokens,
      });
      const materialized = await materializeDirectExport3mf({
        repository: this.repo,
        reposDir: this.deps.reposDir,
        tenantExportsDir: this.getExportsDir(),
      }, {
        profileId: command.profile_id,
        tokens: command.tokens,
      });
      if (materialized.kind !== "materialized") {
        throw new AcceptedPlateExportPublicError(directExportError(materialized));
      }
      const downloadUrl = this.downloadUrlForPath(materialized.absolutePath);
      if (!downloadUrl) throw new Error("Direct export failed.");
      return parseDirectExportJobResult({
        format: "direct-export-3mf-job-v1",
        profile_id: command.profile_id,
        basis: {
          profile_id: materialized.basis.profileId,
          plan_version: materialized.basis.planVersion,
          plan_revision_id: materialized.basis.revisionId,
          plan_revision_digest: materialized.basis.revisionDigest,
          required_unit_mapping_digest: materialized.basis.requiredUnitMappingDigest,
        },
        download_url: downloadUrl,
        filename: materialized.filename,
        tokens: materialized.tokens,
      });
    } catch (error) {
      if (error instanceof AcceptedPlateExportPublicError) throw error;
      return unexpectedFailure();
    }
  }

  private async runPrinterUpload(
    jobId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const profileRaw = payload.profile_id;
    const profileId =
      typeof profileRaw === "number"
        ? profileRaw
        : typeof profileRaw === "string" && profileRaw.trim()
          ? Number(profileRaw)
          : undefined;
    return runPrinterUploadJob(
      this.repo,
      {
        printer_id: String(payload.printer_id ?? ""),
        artifact_path: String(payload.artifact_path ?? ""),
        filename: String(payload.filename ?? "print.gcode"),
        start: Boolean(payload.start),
        host_name: typeof payload.host_name === "string" ? payload.host_name : undefined,
        profile_id:
          typeof profileId === "number" && Number.isInteger(profileId) && profileId > 0
            ? profileId
            : undefined,
        checkoff_units: Array.isArray(payload.checkoff_units)
          ? parseCheckoffUnits(payload.checkoff_units)
          : undefined,
        unlabeled_names: (() => {
          const names = parseUnlabeledNames(payload.unlabeled_names);
          return names.length ? names : undefined;
        })(),
        upload_job_id: jobId,
      },
      (patch) => this.emit(jobId, patch),
    );
  }

  async get(jobId: string, tenantId: string): Promise<JobSnapshot | null> {
    this.pruneCompletedJobs();
    if (!this.isOwnedBy(jobId, tenantId)) return null;
    return this.jobs.get(jobId) ?? null;
  }

  /** Wait until a job reaches a terminal status (or timeout). */
  async waitForTerminal(
    jobId: string,
    timeoutMs = 120_000,
    tenantId = getRequestTenantId(),
  ): Promise<JobSnapshot> {
    return new Promise<JobSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub?.();
        reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsub = this.subscribe(jobId, tenantId, (event) => {
        if (this.isTerminal(event)) {
          clearTimeout(timer);
          unsub?.();
          resolve(event);
        }
      });
      if (!unsub) {
        clearTimeout(timer);
        reject(new Error(`Job ${jobId} not found`));
        return;
      }
      // Close race: job may have finished between start and subscribe.
      const existing = this.jobs.get(jobId);
      if (existing && this.isTerminal(existing)) {
        clearTimeout(timer);
        unsub();
        resolve(existing);
      }
    });
  }

  async cancel(jobId: string, tenantId: string): Promise<boolean> {
    if (!this.isOwnedBy(jobId, tenantId)) return false;
    const snap = this.jobs.get(jobId);
    if (!snap || snap.status === "done" || snap.status === "error" || snap.status === "cancelled") {
      return false;
    }
    snap.status = "cancelled";
    snap.message = "Cancelled";
    snap.finished_at = new Date().toISOString();
    this.touchMeta(jobId);
    this.pruneCompletedJobs();
    return true;
  }
}

export async function registerJobRoutes(
  app: FastifyInstance,
  jobs: InProcessJobRunner,
  _config?: { deployMode?: string },
): Promise<void> {
  const limited = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.post("/jobs/sync", limited, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job_id = await jobs.start("sync", body, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/import-scan", async (request) => {
    const body = request.body as { project_id?: number };
    const job_id = await jobs.start("import-scan", { project_id: body.project_id }, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/check-source-updates", async (request) => {
    const job_id = await jobs.start("check-source-updates", {}, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/extract-source-docs", async (request) => {
    const body = request.body as { project_id?: number };
    const job_id = await jobs.start(
      "extract-source-docs",
      { project_id: body.project_id },
      request.tenantId,
    );
    return { job_id };
  });

  app.post("/jobs/export-stl-pack", limited, async (request, reply) => {
    const body = request.body as {
      profile_id?: number;
      missing_only?: boolean;
      group_by?: string;
    };
    if (!body.profile_id || !jobs.getRepo().getOwnedProfileIdentity(body.profile_id)) {
      return sendProblem(reply, 404, "Not Found", "Profile not found");
    }
    const job_id = await jobs.start(
      "export-stl-pack",
      {
        profile_id: body.profile_id,
        missing_only: body.missing_only ?? false,
        group_by: body.group_by === "color" ? "color" : "color_dir",
      },
      request.tenantId,
    );
    return { job_id };
  });

  app.post("/jobs/export-checklist-html", async (request, reply) => {
    const body = request.body as { profile_id?: number };
    if (!body.profile_id || !jobs.getRepo().getOwnedProfileIdentity(body.profile_id)) {
      return sendProblem(reply, 404, "Not Found", "Profile not found");
    }
    const job_id = await jobs.start(
      "export-checklist-html",
      { profile_id: body.profile_id },
      request.tenantId,
    );
    return { job_id };
  });

  app.post("/jobs/export-kit-bundle", limited, async (request, reply) => {
    const body = request.body as { profile_id?: number; include_print_progress?: boolean };
    if (!body.profile_id || !jobs.getRepo().getOwnedProfileIdentity(body.profile_id)) {
      return sendProblem(reply, 404, "Not Found", "Profile not found");
    }
    const job_id = await jobs.start(
      "export-kit-bundle",
      {
        profile_id: body.profile_id,
        include_print_progress: body.include_print_progress ?? false,
      },
      request.tenantId,
    );
    return { job_id };
  });

  app.post("/jobs/export-accepted-plate-3mf", limited, async (request, reply) => {
    if (!isRecord(request.body)) {
      return reply.status(400).send({
        detail: "profile_id and expected_plate_revision_id are required",
        code: "invalid_request",
      });
    }
    const profileId = positiveSafeInteger(request.body.profile_id);
    const expectedPlateRevisionId = positiveSafeInteger(request.body.expected_plate_revision_id);
    if (profileId == null || expectedPlateRevisionId == null) {
      return reply.status(400).send({
        detail: "profile_id and expected_plate_revision_id must be positive integers",
        code: "invalid_request",
      });
    }
    if (!jobs.getRepo().getOwnedProfileIdentity(profileId)) {
      return reply.status(404).send({ detail: "Profile not found", code: "profile_not_found" });
    }
    const payload: StartAcceptedPlateExportRequest = {
      profile_id: profileId,
      expected_plate_revision_id: expectedPlateRevisionId,
    };
    const job_id = await jobs.start("export-accepted-plate-3mf", payload, request.tenantId);
    return { job_id };
  });

  app.post("/jobs/export-direct-3mf", limited, async (request, reply) => {
    let payload: StartDirectExportRequest;
    try {
      payload = parseStartDirectExportRequest(request.body);
    } catch {
      return reply.status(400).send({
        detail: "profile_id and tokens are required",
        code: "invalid_request",
      });
    }
    if (!jobs.getRepo().getOwnedProfileIdentity(payload.profile_id)) {
      return reply.status(404).send({ detail: "Profile not found", code: "profile_not_found" });
    }
    const job_id = await jobs.start("export-direct-3mf", payload, request.tenantId);
    return { job_id };
  });

  app.post(
    "/jobs/printer-upload",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let artifactPath: string | null = null;

      try {
        const parsed = await parsePrinterUploadMultipart(request, {
          exportsDir: jobs.getExportsDir(request.tenantId),
        });
        if (!parsed.ok) {
          return sendProblem(
            reply,
            parsed.error.status,
            parsed.error.title,
            parsed.error.detail,
          );
        }

        const {
          printer_id: printerId,
          start,
          filename: baseName,
          artifact_path,
          profile_id: profileId,
          checkoff_units_raw: checkoffUnitsRaw,
          unlabeled_names_raw: unlabeledNamesRaw,
        } = parsed.value;
        artifactPath = artifact_path;

        const checkoff_units = parseCheckoffUnits(checkoffUnitsRaw);
        const unlabeledParsed = parseUnlabeledNames(unlabeledNamesRaw);
        const unlabeled_names = unlabeledParsed.length ? unlabeledParsed : undefined;
        // GRE-232: Send must bind to a plan (active spine). No plan → reject.
        if (profileId == null) {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            "Pick a plan to bind this send (profile_id required)",
          );
        }
        if (!jobs.getRepo().getOwnedProfileIdentity(profileId)) {
          return sendProblem(reply, 404, "Not Found", "Profile not found");
        }

        const repo = jobs.getRepo();
        const machine = loadFleet(repo).find((m) => m.id === printerId);
        if (!machine) {
          return sendProblem(reply, 404, "Not Found", "Fleet printer not found");
        }
        const integrationId = machine.integration_id?.trim();
        if (!integrationId) {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            "Printer is not linked to a host. Link a Moonraker or PrusaLink host in Settings.",
          );
        }
        const integration = getIntegrationConfig(repo, integrationId);
        if (!integration) {
          return sendProblem(reply, 400, "Bad Request", "Linked printer host was not found");
        }
        if (integration.type !== "moonraker" && integration.type !== "prusalink") {
          return sendProblem(
            reply,
            400,
            "Bad Request",
            `Upload is not supported for ${integration.type}`,
          );
        }

        if (start) {
          const adapter = getIntegrationAdapter(integration.type);
          let hostState: string = "unknown";
          try {
            const status = adapter?.getStatus
              ? await adapter.getStatus(integration.config)
              : { state: "unknown" as const };
            hostState = status.state;
          } catch {
            hostState = "offline";
          }
          if (hostState !== "idle" && hostState !== "complete") {
            return sendProblem(
              reply,
              409,
              "Conflict",
              `Printer is ${hostState} — wait for Idle or queue for idle`,
            );
          }
        }

        const job_id = await jobs.start(
          "printer-upload",
          {
            printer_id: printerId,
            artifact_path: artifactPath,
            filename: baseName,
            start,
            host_name: integration.name,
            profile_id: profileId,
            checkoff_units,
            unlabeled_names,
          },
          request.tenantId,
        );
        artifactPath = null;
        return { job_id };
      } finally {
        if (artifactPath) {
          try {
            rmSync(artifactPath, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
    },
  );

  app.get("/jobs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const snap = await jobs.get(id, request.tenantId);
    if (!snap) return reply.status(404).send({ detail: "Job not found" });
    return snap;
  });
}

export function registerJobWebSocket(
  app: FastifyInstance,
  jobs: InProcessJobRunner,
): void {
  app.get("/ws/jobs/:jobId", { websocket: true }, (socket, request) => {
    const jobId = (request.params as { jobId: string }).jobId;
    void jobs.get(jobId, request.tenantId).then((snap) => {
      if (!snap) {
        socket.close(1008, "Job not found");
        return;
      }
      socket.send(JSON.stringify(snap));
      if (snap.status === "done" || snap.status === "error" || snap.status === "cancelled") {
        socket.close();
        return;
      }
      const unsub = jobs.subscribe(jobId, request.tenantId, (event) => {
        socket.send(JSON.stringify(event));
        if (event.status === "done" || event.status === "error" || event.status === "cancelled") {
          socket.close();
        }
      });
      socket.on("close", () => unsub?.());
    });
  });
}

export function createJobRunner(
  getRepo: () => AppRepository,
  dataDir: string,
  options?: { sourceDocsMaxBytes?: number },
): InProcessJobRunner {
  const maxDocs =
    options?.sourceDocsMaxBytes ??
    (() => {
      const raw = Number(process.env.SOURCE_DOCS_MAX_BYTES ?? 1024 * 1024 * 1024);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1024 * 1024 * 1024;
    })();
  return new InProcessJobRunner({
    getRepo,
    reposDir: join(dataDir, "repos"),
    exportsDir: join(dataDir, "exports"),
    dataDir,
    sourceDocsMaxBytes: maxDocs,
  });
}

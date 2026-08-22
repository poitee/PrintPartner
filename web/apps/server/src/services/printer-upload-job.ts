import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { PrinterCheckoffUnit } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { createPrinterCheckoffLink } from "./printer-checkoff-store.js";
import { resolvePlanIdForPrinterFetch } from "./printer-plan-bind.js";
import { loadFleet } from "./printer-fleet.js";

const ALLOWED_EXTENSIONS = new Set([".gcode", ".bgcode", ".gco"]);

/** Remove `exports/.../printer-uploads/<jobId>/` after the host transfer finishes. */
export function cleanupPrinterUploadArtifactDir(artifactPath: string): void {
  const trimmed = artifactPath?.trim();
  if (!trimmed) return;
  try {
    const dir = dirname(trimmed);
    if (basename(dirname(dir)) !== "printer-uploads") return;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function sanitizePrinterUploadFilename(filename: string): string {
  const base = basename(filename.replace(/\\/g, "/")).trim() || "print.gcode";
  const cleaned = base.replace(/[/\\]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === ".." || /^\.+$/.test(cleaned)) {
    return "print.gcode";
  }
  return cleaned;
}

export function isAllowedPrinterUploadFilename(filename: string): boolean {
  const lower = sanitizePrinterUploadFilename(filename).toLowerCase();
  for (const ext of ALLOWED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export type PrinterUploadJobInput = {
  printer_id: string;
  artifact_path: string;
  filename: string;
  start: boolean;
  host_name?: string;
  /** Active plan for Progress verify tracking (Phase D). */
  profile_id?: number;
  /** Incomplete Progress units to mark when the host job completes. */
  checkoff_units?: PrinterCheckoffUnit[];
  /** Object names that did not map — Progress preview only. */
  unlabeled_names?: string[];
  upload_job_id?: string;
};

export type PrinterUploadJobEmit = (patch: {
  message?: string;
  progress?: number;
}) => void;

export async function runPrinterUploadJob(
  repo: AppRepository,
  input: PrinterUploadJobInput,
  emit: PrinterUploadJobEmit,
): Promise<Record<string, unknown>> {
  try {
    return await runPrinterUploadJobInner(repo, input, emit);
  } finally {
    cleanupPrinterUploadArtifactDir(input.artifact_path);
  }
}

async function runPrinterUploadJobInner(
  repo: AppRepository,
  input: PrinterUploadJobInput,
  emit: PrinterUploadJobEmit,
): Promise<Record<string, unknown>> {
  const fleet = loadFleet(repo);
  const machine = fleet.find((m) => m.id === input.printer_id);
  if (!machine) {
    throw new Error("Fleet printer not found");
  }
  const integrationId = machine.integration_id?.trim();
  if (!integrationId) {
    throw new Error(
      "Printer is not linked to a host. Link a Moonraker or PrusaLink host in Settings.",
    );
  }

  const integration = getIntegrationConfig(repo, integrationId);
  if (!integration) {
    throw new Error("Linked printer host integration was not found");
  }
  if (integration.config.enabled === false) {
    throw new Error("Linked printer host is disabled");
  }

  const adapter = getIntegrationAdapter(integration.type);
  if (!adapter?.uploadFile) {
    if (integration.type === "bambu") {
      throw new Error(
        "Direct Bambu upload is not available. Use Export → Open in Bambu Connect (official URL handoff), or Moonraker/PrusaLink for G-code upload.",
      );
    }
    throw new Error(`Upload is not supported for ${integration.type}`);
  }

  const hostLabel = input.host_name ?? integration.name ?? machine.name;
  const filename = basename(input.filename);
  if (!isAllowedPrinterUploadFilename(filename)) {
    throw new Error("Only .gcode / .bgcode / .gco files can be sent to a printer");
  }

  emit({
    message: `Uploading ${filename} to ${hostLabel}`,
    progress: 20,
  });

  emit({
    message: `Uploading ${filename} to ${hostLabel}`,
    progress: 45,
  });

  const result = await adapter.uploadFile(
    integration.config,
    { path: input.artifact_path },
    filename,
    {
      start: input.start,
    },
  );

  if (!result.ok) {
    throw new Error(result.message ?? "Printer upload failed");
  }

  emit({
    message: result.started
      ? `Printing on ${hostLabel}`
      : `Uploaded ${filename} to ${hostLabel}`,
    progress: 90,
  });

  const checkoffUnits = input.checkoff_units ?? [];
  const unlabeledNames = Array.isArray(input.unlabeled_names)
    ? input.unlabeled_names.filter((n) => typeof n === "string" && n.trim())
    : [];
  let checkoffLinkId: string | undefined;
  // GRE-232: stamp plan_id (profile_id) at send — immutable after create.
  // Spine change must not rebind; create even when object parse found no units.
  // Fetch-from-printer uses the same resolve helper (stored wins; unbound → spine).
  const planId = resolvePlanIdForPrinterFetch(input.profile_id, null);
  if (planId != null) {
    const link = createPrinterCheckoffLink(repo, {
      profile_id: planId,
      integration_id: integrationId,
      printer_id: machine.id,
      host_name: hostLabel,
      filename,
      remote_path: result.remote_path ?? filename,
      upload_job_id: input.upload_job_id,
      units: checkoffUnits,
      unlabeled_names: unlabeledNames.length ? unlabeledNames : undefined,
      started: Boolean(result.started),
    });
    checkoffLinkId = link?.id;
  }

  return {
    printer_id: machine.id,
    printer_name: machine.name,
    integration_id: integrationId,
    integration_type: integration.type,
    host_name: hostLabel,
    filename,
    remote_path: result.remote_path ?? filename,
    started: Boolean(result.started),
    message: result.message,
    checkoff_link_id: checkoffLinkId,
    checkoff_units: checkoffLinkId ? checkoffUnits.length : 0,
  };
}

/** Persist an uploaded gcode artifact under exportsDir for the job runner. */
export function persistPrinterUploadArtifact(
  exportsDir: string,
  jobId: string,
  filename: string,
  bytes: Buffer,
): string {
  const safeName = sanitizePrinterUploadFilename(filename);
  const dir = join(exportsDir, "printer-uploads", jobId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeName);
  writeFileSync(path, bytes);
  return path;
}

/** Stream a multipart file to disk; reject when the multipart limit truncates the body. */
export async function streamPrinterUploadArtifact(
  exportsDir: string,
  jobId: string,
  filename: string,
  file: Readable & { truncated?: boolean },
): Promise<string> {
  const safeName = sanitizePrinterUploadFilename(filename);
  const dir = join(exportsDir, "printer-uploads", jobId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeName);
  try {
    await pipeline(file, createWriteStream(path));
  } catch (err) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
  if (file.truncated) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error("Upload exceeded size limit");
  }
  return path;
}

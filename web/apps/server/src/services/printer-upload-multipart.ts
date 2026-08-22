import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import type { FastifyRequest } from "fastify";
import {
  isAllowedPrinterUploadFilename,
  streamPrinterUploadArtifact,
} from "./printer-upload-job.js";

export type PrinterUploadMultipartError = {
  status: number;
  title: string;
  detail: string;
};

export type PrinterUploadMultipartResult = {
  printer_id: string;
  start: boolean;
  filename: string;
  artifact_path: string;
  profile_id?: number;
  checkoff_units_raw?: string;
  unlabeled_names_raw?: string;
  wait_for_idle?: boolean;
  match?: "pinned" | "compatible";
};

export type ParsePrinterUploadMultipartOptions = {
  exportsDir: string;
  /** When true, also parse wait_for_idle and match (send-queue route). */
  allowQueueFields?: boolean;
};

function cleanupArtifact(path: string | null): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Shared multipart parsing for POST /jobs/printer-upload and POST /printer-send-queue.
 * Streams the single G-code file to disk; returns structured fields or an error payload.
 */
export async function parsePrinterUploadMultipart(
  request: FastifyRequest,
  options: ParsePrinterUploadMultipartOptions,
): Promise<
  | { ok: true; value: PrinterUploadMultipartResult }
  | { ok: false; error: PrinterUploadMultipartError }
> {
  let printerId = "";
  let start = false;
  let waitForIdle = true;
  let match: "pinned" | "compatible" = "pinned";
  let filename = "print.gcode";
  let artifactPath: string | null = null;
  let profileId: number | undefined;
  let checkoffUnitsRaw: string | undefined;
  let unlabeledNamesRaw: string | undefined;

  try {
    for await (const part of request.parts()) {
      if (part.type === "field") {
        const value = String(await part.value);
        if (part.fieldname === "printer_id") printerId = value.trim();
        if (part.fieldname === "start") {
          const raw = value.toLowerCase();
          start = raw === "1" || raw === "true" || raw === "yes";
        }
        if (options.allowQueueFields) {
          if (part.fieldname === "wait_for_idle") {
            const raw = value.toLowerCase();
            waitForIdle = !(raw === "0" || raw === "false" || raw === "no");
          }
          if (part.fieldname === "match") {
            const raw = value.trim().toLowerCase();
            if (raw === "compatible") match = "compatible";
            else if (raw === "pinned") match = "pinned";
          }
        }
        if (part.fieldname === "profile_id" || part.fieldname === "plan_id") {
          const n = Number(value);
          if (Number.isInteger(n) && n > 0) profileId = n;
        }
        if (part.fieldname === "checkoff_units") {
          checkoffUnitsRaw = value;
        }
        if (part.fieldname === "unlabeled_names") {
          unlabeledNamesRaw = value;
        }
        continue;
      }
      if (part.type !== "file") continue;
      if (part.fieldname !== "file" && part.fieldname !== "gcode") {
        part.file.resume();
        continue;
      }
      if (artifactPath) {
        part.file.resume();
        cleanupArtifact(artifactPath);
        artifactPath = null;
        return {
          ok: false,
          error: {
            status: 400,
            title: "Bad Request",
            detail: "Only one G-code file is allowed",
          },
        };
      }
      filename = (part.filename || "print.gcode").replace(/\\/g, "/");
      try {
        artifactPath = await streamPrinterUploadArtifact(
          options.exportsDir,
          randomUUID(),
          basename(filename),
          part.file,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/size limit/i.test(message)) {
          return {
            ok: false,
            error: {
              status: 413,
              title: "Payload Too Large",
              detail: message,
            },
          };
        }
        throw err;
      }
    }

    if (!printerId) {
      cleanupArtifact(artifactPath);
      artifactPath = null;
      return {
        ok: false,
        error: {
          status: 400,
          title: "Bad Request",
          detail: "printer_id is required",
        },
      };
    }
    if (!artifactPath) {
      return {
        ok: false,
        error: {
          status: 400,
          title: "Bad Request",
          detail: "G-code file required",
        },
      };
    }

    const baseName = basename(filename);
    if (!isAllowedPrinterUploadFilename(baseName)) {
      cleanupArtifact(artifactPath);
      artifactPath = null;
      return {
        ok: false,
        error: {
          status: 400,
          title: "Bad Request",
          detail: "Only .gcode / .bgcode / .gco files can be sent to a printer",
        },
      };
    }

    const value: PrinterUploadMultipartResult = {
      printer_id: printerId,
      start,
      filename: baseName,
      artifact_path: artifactPath,
      profile_id: profileId,
      checkoff_units_raw: checkoffUnitsRaw,
      unlabeled_names_raw: unlabeledNamesRaw,
    };
    if (options.allowQueueFields) {
      value.wait_for_idle = waitForIdle;
      value.match = match;
    }
    artifactPath = null;
    return { ok: true, value };
  } finally {
    cleanupArtifact(artifactPath);
  }
}

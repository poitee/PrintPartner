import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { sendProblem } from "../lib/api-error.js";
import { readFeatureAccess } from "../lib/feature-access.js";
import { desktopFeaturesEnabled } from "../lib/feature-toggles.js";
import {
  bambuConnectDisplayName,
  buildBambuConnectUrl,
  isAllowedBambuConnectFilename,
  isLikelyContainerRuntime,
  resolveBambuConnectHostPath,
  sanitizeBambuConnectFilename,
  shouldAttemptBambuConnectLaunch,
  tryLaunchBambuConnectUrl,
} from "../services/bambu-connect.js";
import { parseCheckoffUnits } from "../services/printer-checkoff.js";
import { createPrinterCheckoffLink } from "../services/printer-checkoff-store.js";
import { loadFleet } from "../services/printer-fleet.js";
import type { InProcessJobRunner } from "../services/job-runner.js";
import {
  MAX_MULTIPART_FIELD_BYTES,
  MAX_PRINT_FILE_UPLOAD_BYTES,
  PRINT_FILE_UPLOAD_TOO_LARGE_DETAIL,
} from "../services/upload-limits.js";
import { sweepExpiredTransferArtifacts } from "../services/transfer-artifact-retention.js";

type RouteDeps = {
  repo: AppRepository;
  jobs: InProcessJobRunner;
};

async function streamBambuConnectArtifact(
  exportsDir: string,
  handoffId: string,
  filename: string,
  file: Readable & { truncated?: boolean },
): Promise<string> {
  const safeName = sanitizeBambuConnectFilename(filename);
  const dir = join(exportsDir, "bambu-connect", handoffId);
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

function assertHandoffArtifactPath(exportsDir: string, artifactPath: string): string {
  const root = resolve(exportsDir, "bambu-connect");
  const resolved = resolve(artifactPath);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== resolved) {
    throw new Error("Invalid artifact path");
  }
  return resolved;
}

function discardHandoff(exportsDir: string, handoffId: string): void {
  if (!handoffId) return;
  try {
    rmSync(join(exportsDir, "bambu-connect", handoffId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Official Bambu Connect handoff — stage a sliced 3MF/G-code and return (or open)
 * the bambu-connect://import-file URL. No MQTT print-start.
 */
export async function registerBambuConnectRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.post(
    "/bambu-connect/handoff",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let printerId = "";
      let launchField: boolean | undefined;
      let filename = "print.3mf";
      let artifactPath: string | null = null;
      let handoffId = "";
      let profileId: number | undefined;
      let checkoffUnitsRaw: string | undefined;
      let retainHandoff = false;
      const requireAdmission = desktopFeaturesEnabled();
      let exportsDir: string | undefined;
      if (!requireAdmission) {
        exportsDir = deps.jobs.getExportsDir(request.tenantId);
        sweepExpiredTransferArtifacts(exportsDir, { kinds: ["bambu-connect"] });
      }

      const reject = (status: number, title: string, detail: string) => {
        if (exportsDir !== undefined) discardHandoff(exportsDir, handoffId);
        artifactPath = null;
        handoffId = "";
        return sendProblem(reply, status, title, detail);
      };

      try {
        for await (const part of request.parts({
          limits: {
            fileSize: MAX_PRINT_FILE_UPLOAD_BYTES,
            files: 1,
            fields: 5,
            fieldSize: MAX_MULTIPART_FIELD_BYTES,
            parts: 6,
          },
        })) {
          if (part.type === "field") {
            const value = String(await part.value);
            if (part.fieldname === "printer_id") printerId = value.trim();
            if (part.fieldname === "launch") {
              const raw = value.toLowerCase();
              if (raw === "0" || raw === "false" || raw === "no") launchField = false;
              else if (raw === "1" || raw === "true" || raw === "yes") launchField = true;
            }
            if (part.fieldname === "profile_id" || part.fieldname === "plan_id") {
              if (requireAdmission && profileId != null) {
                return reject(400, "Bad Request", "Only one profile_id or plan_id is allowed");
              }
              const n = Number(value);
              if (requireAdmission && (!Number.isSafeInteger(n) || n <= 0)) {
                return reject(400, "Bad Request", "A valid profile_id or plan_id is required");
              }
              if (Number.isInteger(n) && n > 0) profileId = n;
            }
            if (part.fieldname === "checkoff_units") {
              checkoffUnitsRaw = value;
            }
            continue;
          }
          if (part.type !== "file") continue;
          if (
            part.fieldname !== "file" &&
            part.fieldname !== "gcode" &&
            part.fieldname !== "3mf"
          ) {
            part.file.resume();
            continue;
          }
          if (artifactPath) {
            part.file.resume();
            return reject(400, "Bad Request", "Only one file is allowed");
          }
          if (requireAdmission) {
            if (profileId != null && !deps.repo.getOwnedProfileIdentity(profileId)) {
              part.file.resume();
              return reject(404, "Not Found", "Profile not found");
            }
            const access = readFeatureAccess(() => deps.repo, "bambu", profileId);
            if (access.kind !== "allowed") {
              part.file.resume();
              const status = access.kind === "disabled" ? 403 : 500;
              return reply.status(status).send({
                status, title: access.kind === "disabled" ? "Forbidden" : "Internal Server Error",
                detail: access.error, code: access.code,
              });
            }
            if (profileId == null) {
              part.file.resume();
              return reject(400, "Bad Request", "Pick a plan before the file (profile_id or plan_id required)");
            }
          }
          filename = (part.filename || "print.3mf").replace(/\\/g, "/");
          const candidate = sanitizeBambuConnectFilename(basename(filename));
          if (!isAllowedBambuConnectFilename(candidate)) {
            part.file.resume();
            return reject(
              400,
              "Bad Request",
              "Only .3mf / .gcode.3mf / .gcode / .gco files can be handed off to Bambu Connect",
            );
          }
          if (exportsDir === undefined) {
            exportsDir = deps.jobs.getExportsDir(request.tenantId);
            sweepExpiredTransferArtifacts(exportsDir, { kinds: ["bambu-connect"] });
          }
          handoffId = randomUUID();
          try {
            artifactPath = await streamBambuConnectArtifact(
              exportsDir,
              handoffId,
              candidate,
              part.file,
            );
          } catch (err) {
            discardHandoff(exportsDir, handoffId);
            handoffId = "";
            const message = err instanceof Error ? err.message : String(err);
            if (/size limit/i.test(message)) {
              return sendProblem(
                reply,
                413,
                "Payload Too Large",
                PRINT_FILE_UPLOAD_TOO_LARGE_DETAIL,
              );
            }
            throw err;
          }
        }

        if (!artifactPath || !handoffId) {
          return reject(400, "Bad Request", "Sliced .3mf or .gcode file required");
        }

        const baseName = sanitizeBambuConnectFilename(basename(filename));
        if (!isAllowedBambuConnectFilename(baseName)) {
          return reject(
            400,
            "Bad Request",
            "Only .3mf / .gcode.3mf / .gcode / .gco files can be handed off to Bambu Connect",
          );
        }

        const checkoff_units = parseCheckoffUnits(checkoffUnitsRaw);
        if (profileId == null) {
          return reject(
            400,
            "Bad Request",
            "Pick a plan to bind this send (profile_id required)",
          );
        }
        if (!deps.repo.getOwnedProfileIdentity(profileId)) {
          return reject(404, "Not Found", "Profile not found");
        }

        let hostName = "Bambu Connect";
        let integrationId: string | undefined;
        let fleetPrinterId: string | undefined;

        if (printerId) {
          const machine = loadFleet(deps.repo).find((m) => m.id === printerId);
          if (!machine) {
            return reject(404, "Not Found", "Fleet printer not found");
          }
          const iid = machine.integration_id?.trim();
          if (!iid) {
            return reject(400, "Bad Request", "Printer is not linked to a Bambu host");
          }
          const integration = getIntegrationConfig(deps.repo, iid);
          if (!integration || integration.type !== "bambu") {
            return reject(
              400,
              "Bad Request",
              "Connect handoff requires a fleet machine linked to a Bambu host",
            );
          }
          integrationId = iid;
          fleetPrinterId = machine.id;
          hostName = integration.name;
        }

        if (requireAdmission) {
          writeFileSync(join(dirname(artifactPath), ".plan-id"), String(profileId), { flag: "wx" });
        }

        const hostPath = resolveBambuConnectHostPath(artifactPath);
        const displayName = bambuConnectDisplayName(baseName);
        const connect_url = buildBambuConnectUrl(hostPath, displayName);

        let launched = false;
        let launch_error: string | undefined;
        const attemptLaunch = shouldAttemptBambuConnectLaunch({
          requestLaunch: launchField,
        });
        if (attemptLaunch) {
          const result = await tryLaunchBambuConnectUrl(connect_url);
          launched = result.launched;
          launch_error = result.error;
        }

        let checkoff_link_id: string | undefined;
        if (profileId != null && integrationId && fleetPrinterId) {
          const link = createPrinterCheckoffLink(deps.repo, {
            profile_id: profileId,
            integration_id: integrationId,
            printer_id: fleetPrinterId,
            host_name: hostName,
            filename: baseName,
            units: checkoff_units,
            started: launched,
          });
          checkoff_link_id = link?.id;
        }

        const inContainer = isLikelyContainerRuntime();
        const message = launched
          ? `Opened Bambu Connect with ${baseName}`
          : inContainer
            ? `Staged ${baseName}. Download the file (or map BAMBU_CONNECT_HOST_PATH_MAP) and open it in Bambu Connect. Container paths are not visible to Connect on the host.`
            : `Staged ${baseName}. Open the Connect URL or copy it if Bambu Connect did not launch.`;

        retainHandoff = true;
        return {
          handoff_id: handoffId,
          filename: baseName,
          absolute_path: hostPath,
          connect_url,
          launched,
          launch_error,
          in_container: inContainer,
          download_path: `/bambu-connect/handoff/${handoffId}/file${requireAdmission ? `?profile_id=${profileId}` : ""}`,
          checkoff_link_id,
          checkoff_units: checkoff_units.length || undefined,
          message,
        };
      } finally {
        if (!retainHandoff && exportsDir !== undefined) discardHandoff(exportsDir, handoffId);
      }
    },
  );

  app.get("/bambu-connect/handoff/:id/file", async (request, reply) => {
    const gated = desktopFeaturesEnabled();
    let queryPlanId: number | undefined;
    if (gated) {
      const values = new URL(request.url, "http://localhost").searchParams.getAll("profile_id");
      if (values.length) {
        queryPlanId = Number(values[0]);
        if (values.length !== 1 || !Number.isSafeInteger(queryPlanId) || queryPlanId <= 0) {
          return sendProblem(reply, 400, "Bad Request", "Invalid profile_id");
        }
        if (!deps.repo.getOwnedProfileIdentity(queryPlanId)) {
          return sendProblem(reply, 404, "Not Found", "Profile not found");
        }
      }
    }
    const access = readFeatureAccess(() => deps.repo, "bambu", queryPlanId);
    if (access.kind !== "allowed") {
      const status = access.kind === "disabled" ? 403 : 500;
      return reply.status(status).send({
        status, title: access.kind === "disabled" ? "Forbidden" : "Internal Server Error",
        detail: access.error, code: access.code,
      });
    }
    const id = String((request.params as { id: string }).id ?? "").trim();
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      return sendProblem(reply, 400, "Bad Request", "Invalid handoff id");
    }
    const exportsDir = deps.jobs.getExportsDir(request.tenantId);
    const dir = join(exportsDir, "bambu-connect", id);
    if (gated) {
      let boundPlanId: number | undefined;
      try {
        const binding = readFileSync(join(dir, ".plan-id"), "utf8");
        boundPlanId = Number(binding);
        if (!/^[1-9][0-9]*$/.test(binding) || !Number.isSafeInteger(boundPlanId)) {
          throw new Error("Invalid Plan binding");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          return reply.status(500).send({ status: 500, title: "Internal Server Error", detail: "Stored handoff Plan binding is invalid.", code: "HANDOFF_BINDING_INVALID" });
        }
      }
      if (boundPlanId !== undefined) {
        if (!deps.repo.getOwnedProfileIdentity(boundPlanId)) {
          return sendProblem(reply, 404, "Not Found", "Profile not found");
        }
        if (queryPlanId !== undefined && queryPlanId !== boundPlanId) {
          return sendProblem(reply, 403, "Forbidden", "Handoff belongs to another Plan");
        }
      }
      const artifactAccess = readFeatureAccess(() => deps.repo, "bambu", boundPlanId);
      if (artifactAccess.kind !== "allowed") {
        const status = artifactAccess.kind === "disabled" ? 403 : 500;
        return reply.status(status).send({
          status, title: artifactAccess.kind === "disabled" ? "Forbidden" : "Internal Server Error",
          detail: artifactAccess.error, code: artifactAccess.code,
        });
      }
    }
    sweepExpiredTransferArtifacts(exportsDir, { kinds: ["bambu-connect"] });
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return sendProblem(reply, 404, "Not Found", "Handoff not found");
    }
    const file = entries.find((e) => isAllowedBambuConnectFilename(e));
    if (!file) {
      return sendProblem(reply, 404, "Not Found", "Handoff file not found");
    }
    let path: string;
    try {
      path = assertHandoffArtifactPath(exportsDir, join(dir, file));
    } catch {
      return sendProblem(reply, 400, "Bad Request", "Invalid artifact path");
    }
    const asciiName = file.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
    reply.header("Content-Type", "application/octet-stream");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file)}`,
    );
    reply.raw.once("finish", () => discardHandoff(exportsDir, id));
    return reply.send(createReadStream(path));
  });
}

import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { sendProblem } from "../lib/api-error.js";
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
import type { InProcessJobRunner } from "./jobs.js";

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
      const exportsDir = deps.jobs.getExportsDir(request.tenantId);

      const reject = (status: number, title: string, detail: string) => {
        discardHandoff(exportsDir, handoffId);
        artifactPath = null;
        handoffId = "";
        return sendProblem(reply, status, title, detail);
      };

      for await (const part of request.parts()) {
        if (part.type === "field") {
          const value = String(await part.value);
          if (part.fieldname === "printer_id") printerId = value.trim();
          if (part.fieldname === "launch") {
            const raw = value.toLowerCase();
            if (raw === "0" || raw === "false" || raw === "no") launchField = false;
            else if (raw === "1" || raw === "true" || raw === "yes") launchField = true;
          }
          if (part.fieldname === "profile_id" || part.fieldname === "plan_id") {
            const n = Number(value);
            if (Number.isInteger(n) && n > 0) profileId = n;
          }
          if (part.fieldname === "checkoff_units") {
            checkoffUnitsRaw = value;
          }
          continue;
        }
        if (part.type !== "file") continue;
        if (part.fieldname !== "file" && part.fieldname !== "gcode" && part.fieldname !== "3mf") {
          part.file.resume();
          continue;
        }
        if (artifactPath) {
          part.file.resume();
          return reject(400, "Bad Request", "Only one file is allowed");
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
            return sendProblem(reply, 413, "Payload Too Large", message);
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
      // GRE-232: Bambu handoff stamps plan_id; require an active spine plan.
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
      // GRE-232: stamp plan_id at Bambu handoff whenever a plan is bound.
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
          ? `Staged ${baseName}. Download the file (or map BAMBU_CONNECT_HOST_PATH_MAP) and open in Bambu Connect — container paths are not visible to Connect on the host.`
          : `Staged ${baseName}. Open the Connect URL or copy it if Bambu Connect did not launch.`;

      return {
        handoff_id: handoffId,
        filename: baseName,
        absolute_path: hostPath,
        connect_url,
        launched,
        launch_error,
        in_container: inContainer,
        download_path: `/bambu-connect/handoff/${handoffId}/file`,
        checkoff_link_id,
        checkoff_units: checkoff_units.length || undefined,
        message,
      };
    },
  );

  app.get("/bambu-connect/handoff/:id/file", async (request, reply) => {
    const id = String((request.params as { id: string }).id ?? "").trim();
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      return sendProblem(reply, 400, "Bad Request", "Invalid handoff id");
    }
    const exportsDir = deps.jobs.getExportsDir(request.tenantId);
    const dir = join(exportsDir, "bambu-connect", id);
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
    return reply.send(createReadStream(path));
  });
}

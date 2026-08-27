import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import type { AppRepository } from "../db/repository.js";
import {
  loadFleet,
  loadPrinterPresets,
  newMachineFromPreset,
  parsePrinterMachine,
  saveFleet,
} from "../services/printer-fleet.js";
import {
  currentPresetDetails,
  nullablePositiveMm,
  parsePrinterDetails,
  positiveMm,
  samePresetSnapshot,
  type PrinterDetailsInput,
} from "./printer-route-model.js";
import { buildAssignmentView } from "../services/printer-profile-assignments.js";
import type { ProfileSourceMode } from "../services/printer-profile-assignments.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { sendProblem } from "../lib/api-error.js";

type RouteDeps = { repo: AppRepository };

function findFleetPrinter(repo: AppRepository, printerId: string) {
  return loadFleet(repo).find((m) => m.id === printerId) ?? null;
}

type PrinterHostCapability =
  | {
      ok: false;
      error: "printer_not_found" | "host_not_linked" | "host_not_available";
    }
  | {
      ok: true;
      printer: NonNullable<ReturnType<typeof findFleetPrinter>>;
      integration: NonNullable<ReturnType<typeof getIntegrationConfig>>;
      adapter: NonNullable<ReturnType<typeof getIntegrationAdapter>>;
    };

function printerHostCapability(
  repo: AppRepository,
  printerId: string,
): PrinterHostCapability {
  const printer = findFleetPrinter(repo, printerId);
  if (!printer) return { ok: false, error: "printer_not_found" };
  const integrationId = printer.integration_id?.trim();
  if (!integrationId) return { ok: false, error: "host_not_linked" };
  const integration = getIntegrationConfig(repo, integrationId);
  if (!integration || integration.config.enabled === false) {
    return { ok: false, error: "host_not_available" };
  }
  const adapter = getIntegrationAdapter(integration.type);
  if (!adapter) return { ok: false, error: "host_not_available" };
  return { ok: true, printer, integration, adapter };
}

function publicCapabilityError(
  reply: Parameters<typeof sendProblem>[0],
  error: "printer_not_found" | "host_not_linked" | "host_not_available",
) {
  if (error === "printer_not_found") {
    return sendProblem(reply, 404, "Not Found", "Printer not found");
  }
  if (error === "host_not_linked") {
    return sendProblem(reply, 409, "Conflict", "Printer is not linked to a host");
  }
  return sendProblem(reply, 503, "Service Unavailable", "Printer host is unavailable");
}

async function sendUpstreamResponse(
  reply: Parameters<typeof sendProblem>[0],
  response: Response,
) {
  if (!response.ok || !response.body) {
    try {
      await response.arrayBuffer();
    } catch {
      /* ignore */
    }
    return sendProblem(
      reply,
      response.status === 404 ? 404 : 502,
      response.status === 404 ? "Not Found" : "Bad Gateway",
      response.status === 404
        ? "Printer resource not found"
        : `Printer host returned HTTP ${response.status}`,
    );
  }
  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  if (contentType) reply.header("Content-Type", contentType);
  if (contentLength) reply.header("Content-Length", contentLength);
  reply.header("Cache-Control", "private, no-store");
  return reply.send(Readable.fromWeb(response.body));
}

export async function registerPrinterRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/printers", async () => ({ printers: loadFleet(deps.repo) }));

  app.get("/printers/:id/files", async (request, reply) => {
    const printerId = (request.params as { id: string }).id;
    const capability = printerHostCapability(deps.repo, printerId);
    if (!capability.ok) return publicCapabilityError(reply, capability.error);
    if (!capability.adapter.files) {
      return sendProblem(reply, 501, "Not Implemented", "Printer host does not support file browsing");
    }
    try {
      return { files: await capability.adapter.files.list(capability.integration.config) };
    } catch (error) {
      request.log.warn(
        { printerId, integrationId: capability.integration.id },
        "Printer file browsing failed",
      );
      return sendProblem(
        reply,
        502,
        "Bad Gateway",
        error instanceof Error ? error.message : "Could not browse printer files",
      );
    }
  });

  app.get("/printers/:id/files/content", async (request, reply) => {
    const printerId = (request.params as { id: string }).id;
    const fileId = String((request.query as { id?: unknown }).id ?? "").trim();
    if (!fileId) return sendProblem(reply, 400, "Bad Request", "id is required");
    const capability = printerHostCapability(deps.repo, printerId);
    if (!capability.ok) return publicCapabilityError(reply, capability.error);
    if (!capability.adapter.files) {
      return sendProblem(reply, 501, "Not Implemented", "Printer host does not support file browsing");
    }
    try {
      const listed = await capability.adapter.files.list(capability.integration.config);
      if (!listed.some((file) => file.id === fileId)) {
        return sendProblem(reply, 404, "Not Found", "Printer file not found");
      }
      return sendUpstreamResponse(
        reply,
        await capability.adapter.files.open(capability.integration.config, fileId),
      );
    } catch (error) {
      request.log.warn(
        { printerId, integrationId: capability.integration.id },
        "Printer file open failed",
      );
      return sendProblem(
        reply,
        502,
        "Bad Gateway",
        error instanceof Error ? error.message : "Could not open printer file",
      );
    }
  });

  app.get("/printers/:id/cameras", async (request, reply) => {
    const printerId = (request.params as { id: string }).id;
    const capability = printerHostCapability(deps.repo, printerId);
    if (!capability.ok) return publicCapabilityError(reply, capability.error);
    if (!capability.adapter.cameras) return { cameras: [] };
    try {
      return { cameras: await capability.adapter.cameras.list(capability.integration.config) };
    } catch (error) {
      request.log.warn(
        { printerId, integrationId: capability.integration.id },
        "Printer camera discovery failed",
      );
      return sendProblem(
        reply,
        502,
        "Bad Gateway",
        error instanceof Error ? error.message : "Could not discover printer cameras",
      );
    }
  });

  app.get("/printers/:id/cameras/view", async (request, reply) => {
    const printerId = (request.params as { id: string }).id;
    const cameraId = String((request.query as { id?: unknown }).id ?? "").trim();
    if (!cameraId) return sendProblem(reply, 400, "Bad Request", "id is required");
    const capability = printerHostCapability(deps.repo, printerId);
    if (!capability.ok) return publicCapabilityError(reply, capability.error);
    if (!capability.adapter.cameras) {
      return sendProblem(reply, 404, "Not Found", "Printer camera not found");
    }
    try {
      const cameras = await capability.adapter.cameras.list(capability.integration.config);
      if (!cameras.some((camera) => camera.id === cameraId)) {
        return sendProblem(reply, 404, "Not Found", "Printer camera not found");
      }
      return sendUpstreamResponse(
        reply,
        await capability.adapter.cameras.open(capability.integration.config, cameraId),
      );
    } catch (error) {
      request.log.warn(
        { printerId, integrationId: capability.integration.id },
        "Printer camera view failed",
      );
      return sendProblem(
        reply,
        502,
        "Bad Gateway",
        error instanceof Error ? error.message : "Could not open printer camera",
      );
    }
  });

  app.get("/slicer-profile-options", async () => {
    const printers = deps.repo.listSlicerPrinterProfiles().map((row) => {
      const full = deps.repo.getSlicerPrinterProfileById(row.id);
      return {
        id: row.id,
        name: row.name,
        last_synced_at: full?.lastSyncedAt ?? null,
      };
    });
    const filaments = deps.repo.listSlicerFilamentProfiles().map((row) => {
      const full = deps.repo.getSlicerFilamentProfileById(row.id);
      return {
        id: row.id,
        name: row.name,
        material_type: row.materialType ?? null,
        last_synced_at: full?.lastSyncedAt ?? null,
      };
    });
    const processes = deps.repo.listSlicerProcessProfilesDetailed().map((row) => ({
      id: row.id,
      name: row.name,
      last_synced_at: null as string | null,
    }));
    return { printers, filaments, processes };
  });

  app.get("/printers/:id/profile-assignment", async (request, reply) => {
    const printerId = (request.params as { id: string }).id;
    const printer = findFleetPrinter(deps.repo, printerId);
    if (!printer) {
      return reply.status(404).send({ detail: "Printer not found" });
    }
    return buildAssignmentView(deps.repo, printerId, printer.max_filament_slots);
  });

  app.put("/printers/:id/profile-assignment", async (request, reply) => {
    const printerId = (request.params as { id: string }).id;
    const printer = findFleetPrinter(deps.repo, printerId);
    if (!printer) {
      return reply.status(404).send({ detail: "Printer not found" });
    }
    const body = request.body as {
      profile_source?: ProfileSourceMode;
      machine_profile_id?: number | null;
      filament_slots?: Array<{ slot_index?: number; filament_profile_id?: number | null }>;
    };
    const profileSource = body.profile_source ?? "auto_match";
    if (profileSource !== "assigned" && profileSource !== "auto_match") {
      return reply.status(400).send({ detail: "Invalid profile_source" });
    }
    const filamentSlots = (body.filament_slots ?? []).map((slot) => ({
      slotIndex: Number(slot.slot_index ?? 0),
      filamentProfileId: slot.filament_profile_id ?? null,
    }));
    try {
      deps.repo.upsertPrinterProfileAssignment({
        printerId,
        machineProfileId: body.machine_profile_id ?? null,
        profileSource,
        filamentSlots,
      });
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
    return buildAssignmentView(deps.repo, printerId, printer.max_filament_slots);
  });

  app.put("/printers", async (request, reply) => {
    const body = request.body as { printers?: Array<Record<string, unknown>> };
    const raw = body.printers ?? [];
    try {
      const fleet = raw.map((x) => parsePrinterMachine(x));
      saveFleet(deps.repo, fleet);
      return { printers: loadFleet(deps.repo) };
    } catch (e) {
      return reply.status(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/printers", async (request, reply) => {
    const body = request.body as {
      name?: string;
      model?: string;
      preset_id?: string;
      bed_width_mm?: number;
      bed_depth_mm?: number;
      bed_height_mm?: number | null;
      max_filament_slots?: number;
    };
    const name = body.name?.trim() || "Printer";
    const presetId = body.preset_id?.trim();
    let machine;
    if (presetId) {
      const preset = loadPrinterPresets().find((row) => row.id === presetId);
      if (!preset) {
        return reply.status(400).send({ detail: "Unknown Printer preset" });
      }
      machine = newMachineFromPreset(preset, name);
    } else {
      if (!body.model?.trim()) {
        return reply.status(400).send({ detail: "model is required" });
      }
      try {
        machine = parsePrinterMachine({
          id: `printer-${crypto.randomUUID().slice(0, 10)}`,
          name,
          model: body.model.trim(),
          bed_width_mm: positiveMm(body.bed_width_mm, 250, "bed_width_mm"),
          bed_depth_mm: positiveMm(body.bed_depth_mm, 210, "bed_depth_mm"),
          bed_height_mm: nullablePositiveMm(
            body.bed_height_mm,
            250,
            "bed_height_mm",
          ),
          margin_mm: 4,
          max_filament_slots: Math.max(1, Number(body.max_filament_slots ?? 1) || 1),
          loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
          preset_id: null,
        });
      } catch (error) {
        return reply.status(400).send({
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const fleet = loadFleet(deps.repo);
    fleet.push(machine);
    saveFleet(deps.repo, fleet);
    return machine;
  });

  app.put("/printers/:id/details", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const fleet = loadFleet(deps.repo);
    const existing = fleet.find((printer) => printer.id === id);
    if (!existing) {
      return reply.status(404).send({ detail: "Printer not found" });
    }
    let details: PrinterDetailsInput;
    try {
      details = parsePrinterDetails(request.body);
    } catch (error) {
      return reply.status(400).send({
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const existingPresetId = existing.preset_id?.trim() || null;
    const preservesStoredSnapshot =
      details.preset_id !== null &&
      details.preset_id === existingPresetId &&
      samePresetSnapshot(details, existing);
    if (details.preset_id && !preservesStoredSnapshot) {
      const preset = loadPrinterPresets().find((row) => row.id === details.preset_id);
      if (!preset) {
        return reply.status(400).send({ detail: "Unknown Printer preset" });
      }
      const currentDetails = currentPresetDetails(preset, details.name);
      if (
        details.preset_id === existingPresetId &&
        !samePresetSnapshot(details, currentDetails)
      ) {
        return reply.status(400).send({
          detail: "Preset details must match the stored snapshot or current preset",
        });
      }
      details = currentDetails;
    }
    if (details.margin_mm * 2 >= Math.min(details.bed_width_mm, details.bed_depth_mm)) {
      return reply.status(400).send({
        detail: "margin_mm must be less than half of bed width and depth",
      });
    }
    const occupiedRemovedSlots = existing.loaded_filaments.filter(
      (slot) =>
        slot.slot > details.max_filament_slots &&
        (Boolean(slot.filament_color_id?.trim()) || Boolean(slot.label.trim())),
    );
    if (occupiedRemovedSlots.length > 0) {
      const slots = occupiedRemovedSlots.map((slot) => slot.slot).join(", ");
      return reply.status(409).send({
        detail: `Clear loaded filament ${
          occupiedRemovedSlots.length === 1 ? "slot" : "slots"
        } ${slots} before reducing filament slots`,
      });
    }
    saveFleet(
      deps.repo,
      fleet.map((printer) =>
        printer.id === id ? { ...printer, ...details } : printer,
      ),
    );
    const saved = findFleetPrinter(deps.repo, id);
    if (!saved) throw new Error("Saved Printer was not found");
    return saved;
  });

  app.delete("/printers/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const fleet = loadFleet(deps.repo).filter((m) => m.id !== id);
    if (fleet.length === loadFleet(deps.repo).length) {
      return reply.status(404).send({ detail: "Printer not found" });
    }
    saveFleet(deps.repo, fleet);
    return reply.status(204).send();
  });

  const VALID_SLICER_OVERRIDES = new Set(["orca", "prusa", "bambu"]);

  app.put("/printers/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { preferred_slicer?: string | null };
    const fleet = loadFleet(deps.repo);
    const idx = fleet.findIndex((m) => m.id === id);
    if (idx === -1) {
      return reply.status(404).send({ detail: "Printer not found" });
    }
    if (
      body.preferred_slicer !== undefined &&
      body.preferred_slicer !== null &&
      !VALID_SLICER_OVERRIDES.has(body.preferred_slicer)
    ) {
      return reply.status(400).send({
        detail: `preferred_slicer must be one of orca, prusa, bambu, or null (got ${body.preferred_slicer})`,
      });
    }
    if (body.preferred_slicer !== undefined) {
      const value =
        body.preferred_slicer === null
          ? null
          : (body.preferred_slicer as "orca" | "prusa" | "bambu");
      fleet[idx] = { ...fleet[idx], preferred_slicer: value };
    }
    saveFleet(deps.repo, fleet);
    return loadFleet(deps.repo)[idx];
  });

  app.get("/printer-presets", async () => ({ presets: loadPrinterPresets() }));
}

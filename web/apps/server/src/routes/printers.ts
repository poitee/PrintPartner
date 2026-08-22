import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import type { PrinterMachine } from "@print-partner/domain";
import {
  loadFleet,
  loadPrinterPresets,
  newMachineFromPreset,
  parsePrinterMachine,
  saveFleet,
} from "../services/printer-fleet.js";
import { buildAssignmentView } from "../services/printer-profile-assignments.js";
import type { ProfileSourceMode } from "../services/printer-profile-assignments.js";

type RouteDeps = { repo: AppRepository };

type PrinterDetailsInput = Pick<
  PrinterMachine,
  | "name"
  | "model"
  | "bed_width_mm"
  | "bed_depth_mm"
  | "bed_height_mm"
  | "margin_mm"
  | "max_filament_slots"
> & { preset_id: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: "name" | "model"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requiredNumber(
  value: unknown,
  field: "bed_width_mm" | "bed_depth_mm" | "margin_mm",
  allowZero: boolean,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    const requirement = allowZero ? "0 or greater" : "greater than 0";
    throw new Error(`${field} must be ${requirement}`);
  }
  return value;
}

function parsePrinterDetails(value: unknown): PrinterDetailsInput {
  if (!isRecord(value)) throw new Error("Printer details are required");
  const bedHeight = value.bed_height_mm;
  if (
    bedHeight !== null &&
    (typeof bedHeight !== "number" || !Number.isFinite(bedHeight) || bedHeight <= 0)
  ) {
    throw new Error("bed_height_mm must be null or greater than 0");
  }
  const maxFilamentSlots = value.max_filament_slots;
  if (
    typeof maxFilamentSlots !== "number" ||
    !Number.isInteger(maxFilamentSlots) ||
    maxFilamentSlots < 1 ||
    maxFilamentSlots > 4
  ) {
    throw new Error("max_filament_slots must be an integer from 1 to 4");
  }
  const rawPresetId = value.preset_id;
  if (
    rawPresetId !== null &&
    (typeof rawPresetId !== "string" || !rawPresetId.trim())
  ) {
    throw new Error("preset_id must be null or a non-empty string");
  }
  const bedWidth = requiredNumber(value.bed_width_mm, "bed_width_mm", false);
  const bedDepth = requiredNumber(value.bed_depth_mm, "bed_depth_mm", false);
  const margin = requiredNumber(value.margin_mm, "margin_mm", true);
  return {
    name: requiredText(value.name, "name"),
    model: requiredText(value.model, "model"),
    bed_width_mm: bedWidth,
    bed_depth_mm: bedDepth,
    bed_height_mm: bedHeight,
    margin_mm: margin,
    max_filament_slots: maxFilamentSlots,
    preset_id: rawPresetId === null ? null : rawPresetId.trim(),
  };
}

function samePresetSnapshot(
  left: PrinterDetailsInput,
  right: PrinterDetailsInput | PrinterMachine,
): boolean {
  return (
    left.model === right.model &&
    left.bed_width_mm === right.bed_width_mm &&
    left.bed_depth_mm === right.bed_depth_mm &&
    left.bed_height_mm === right.bed_height_mm &&
    left.margin_mm === right.margin_mm &&
    left.max_filament_slots === right.max_filament_slots
  );
}

function currentPresetDetails(
  preset: Parameters<typeof newMachineFromPreset>[0],
  name: string,
): PrinterDetailsInput {
  const machine = newMachineFromPreset(preset, name);
  return {
    name,
    model: machine.model,
    bed_width_mm: machine.bed_width_mm,
    bed_depth_mm: machine.bed_depth_mm,
    bed_height_mm: machine.bed_height_mm,
    margin_mm: machine.margin_mm,
    max_filament_slots: machine.max_filament_slots,
    preset_id: machine.preset_id ?? preset.id,
  };
}

function findFleetPrinter(repo: AppRepository, printerId: string) {
  return loadFleet(repo).find((m) => m.id === printerId) ?? null;
}

function positiveMm(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be greater than 0`);
  }
  return value;
}

function nullablePositiveMm(value: unknown, fallback: number, field: string): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be null or greater than 0`);
  }
  return value;
}

export async function registerPrinterRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/printers", async () => ({ printers: loadFleet(deps.repo) }));

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

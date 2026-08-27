import type { FastifyInstance } from "fastify";
import type { PrinterCheckoffLink } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { AcceptedPlanOperationalIntegrityError } from "../db/accepted-plan-operational.js";
import type { IntegrationPort } from "../integrations/store.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { sendProblem } from "../lib/api-error.js";
import { reconcilePrinterCheckoff } from "../services/printer-checkoff.js";
import {
  dismissHostFailedLink,
  verifyPrinterCheckoff,
} from "../services/printer-checkoff-verify.js";
import { dispatchWebhooks } from "../services/webhook-store.js";
import {
  getPrinterCheckoffLink,
  listAwaitingVerifyPrinterCheckoffLinks,
  listWatchingPrinterCheckoffLinks,
  loadPrinterCheckoffLinks,
  updatePrinterCheckoffLink,
} from "../services/printer-checkoff-store.js";
import { summarizePrintOutcomes } from "../services/printer-outcomes-store.js";
import {
  groupObjectsByPart,
  matchObjectsToFilenames,
} from "../services/gcode-object-parser.js";
import {
  claimUnattributedPrint,
  createUnattributedPrint,
  dismissUnattributedPrint,
  listOpenUnattributedPrints,
  listUnattributedPrints,
  saveUnattributedPrint,
} from "../services/unattributed-print-store.js";
import { normalizePrinterFilename } from "../services/printer-checkoff.js";
import { filterLinkedUnattributedPrints } from "./printer-checkoff-route-model.js";
import { loadFleet } from "../services/printer-fleet.js";
import { deductSpoolmanFilamentAfterVerify } from "../services/spoolman-deduct.js";

type RouteDeps = {
  repo: AppRepository;
  integrations: IntegrationPort;
};

async function getObjectListForIntegration(
  repo: AppRepository,
  integrationId: string,
): Promise<string[]> {
  try {
    const integration = getIntegrationConfig(repo, integrationId);
    if (!integration) return [];
    const adapter = getIntegrationAdapter(integration.type);
    if (!adapter?.getObjectList) return [];
    return await adapter.getObjectList(integration.config);
  } catch {
    return [];
  }
}

async function buildCandidatesFromObjectNames(
  repo: AppRepository,
  objectNames: string[],
): Promise<Array<{ stl_basename: string; copy_count: number; matching_filenames: string[] }>> {
  if (!objectNames.length) return [];

  const profiles = repo.listProfileHeaders();
  const allFilenames: string[] = [];
  for (const profile of profiles) {
    const { parts } = repo.listParts(profile.id, 10000, 0);
    for (const part of parts) {
      if (part.filename && !allFilenames.includes(part.filename)) {
        allFilenames.push(part.filename);
      }
    }
  }

  const grouped = groupObjectsByPart(objectNames);
  const matched = matchObjectsToFilenames(grouped, allFilenames);

  const candidates: Array<{
    stl_basename: string;
    copy_count: number;
    matching_filenames: string[];
  }> = [];
  for (const [stlBasename, plateMatch] of grouped) {
    candidates.push({
      stl_basename: stlBasename,
      copy_count: plateMatch.count,
      matching_filenames: matched.get(stlBasename) ?? [],
    });
  }
  return candidates;
}

function repairEmptyAwaitingLinks(
  repo: AppRepository,
  links: PrinterCheckoffLink[],
  beforeRepair: (link: PrinterCheckoffLink) => void,
): PrinterCheckoffLink[] {
  return links.map((link) => {
    if (link.state !== "awaiting_verify" || link.units.length > 0) return link;
    beforeRepair(link);
    const repaired = repo.materializeAcceptedPrinterLink({ kind: "repair", expectedLink: link });
    return repaired.kind === "repaired" ? repaired.link : link;
  });
}

function claimMatchingUnattributedPrints(
  repo: AppRepository,
  link: PrinterCheckoffLink,
): void {
  for (const print of listOpenUnattributedPrints(repo)) {
    const normalizedFilename = normalizePrinterFilename(print.filename);
    if (
      print.integration_id === link.integration_id &&
      normalizePrinterFilename(link.filename) === normalizedFilename
    ) {
      claimUnattributedPrint(repo, print.id, link.profile_id);
    }
  }
}

export async function registerPrinterCheckoffRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/printer-checkoff", async (request, reply) => {
    let repairContext: { linkId: string; profileId: number } | undefined;
    try {
      const query = request.query as {
        state?: string;
        integration_id?: string;
        profile_id?: string;
      };
      const integrationId = query.integration_id?.trim();
      const profileIdRaw = query.profile_id?.trim();
      const profileId =
        profileIdRaw && Number.isInteger(Number(profileIdRaw))
          ? Number(profileIdRaw)
          : undefined;

      if (query.state === "watching") {
        return { links: listWatchingPrinterCheckoffLinks(deps.repo, integrationId) };
      }
      let links =
        query.state === "awaiting_verify"
          ? listAwaitingVerifyPrinterCheckoffLinks(deps.repo, profileId)
          : loadPrinterCheckoffLinks(deps.repo);
      if (integrationId) {
        links = links.filter((link) => link.integration_id === integrationId);
      }
      if (profileId != null) {
        links = links.filter((link) => link.profile_id === profileId);
      }
      if (
        query.state === "host_failed" ||
        query.state === "dismissed" ||
        query.state === "verified" ||
        query.state === "applied"
      ) {
        const want = query.state === "applied" ? "verified" : query.state;
        links = links.filter((link) => link.state === want);
      }
      links = repairEmptyAwaitingLinks(deps.repo, links, (link) => {
        repairContext = { linkId: link.id, profileId: link.profile_id };
      });
      return { links };
    } catch (error) {
      if (error instanceof AcceptedPlanOperationalIntegrityError) {
        request.log.error(
          { failure: "integrity", code: error.code, ...repairContext },
          "Accepted printer link repair failed",
        );
      } else {
        request.log.error(
          { failure: "unexpected", ...repairContext },
          "Accepted printer link repair failed",
        );
      }
      return sendProblem(reply, 500, "Internal Server Error", "Internal Server Error");
    }
  });

  app.post(
    "/printer-checkoff/reconcile",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body as { integration_id?: string };
      const integrationId = String(body.integration_id ?? "").trim();
      if (!integrationId) {
        return sendProblem(reply, 400, "Bad Request", "integration_id is required");
      }
      const integrationSummary = deps.integrations.get(integrationId);
      if (!integrationSummary) {
        return sendProblem(reply, 404, "Not Found", "Integration not found");
      }

      // Always fetch live host status — never trust a client-supplied snapshot.
      const status = await deps.integrations.getStatus(integrationId);
      const updates = reconcilePrinterCheckoff(deps.repo, integrationId, status);
      const createdLinks: PrinterCheckoffLink[] = [];

      // Handle externally-completed prints (no watching link transitioned)
      if (
        status.state === "complete" &&
        updates.length === 0 &&
        status.filename
      ) {
        const normalizedFilename = normalizePrinterFilename(status.filename);
        // Check if we already stored this as unattributed
        const existing = listUnattributedPrints(deps.repo).find(
          (p) =>
            p.integration_id === integrationId &&
            normalizePrinterFilename(p.filename) === normalizedFilename,
        );
        const existingLink = loadPrinterCheckoffLinks(deps.repo).find(
          (link) =>
            link.integration_id === integrationId &&
            normalizePrinterFilename(link.filename) === normalizedFilename,
        );
        if (!existing && !existingLink) {
          const objectNames = await getObjectListForIntegration(
            deps.repo,
            integrationId,
          );
          const candidates = await buildCandidatesFromObjectNames(
            deps.repo,
            objectNames,
          );
          const unattributedPrint = createUnattributedPrint(
            integrationId,
            "default",
            integrationSummary.name || "Printer",
            status.filename,
            objectNames,
            candidates,
          );
          saveUnattributedPrint(deps.repo, unattributedPrint);
        }
      }

      const openUnattributed = filterLinkedUnattributedPrints(
        listOpenUnattributedPrints(deps.repo),
        loadPrinterCheckoffLinks(deps.repo),
        integrationId,
      );

      if (
        (status.state === "printing" || status.state === "paused") &&
        status.filename
      ) {
        const normalizedFilename = normalizePrinterFilename(status.filename);

        const watching = listWatchingPrinterCheckoffLinks(deps.repo, integrationId);
        const alreadyWatching = watching.some(
          (l) => normalizePrinterFilename(l.filename) === normalizedFilename,
        );

        if (!alreadyWatching) {
          let attributionProfileId: number | undefined;
          try {
            const bindingsRaw = deps.repo.getSetting("printer.plan_bindings");
            const bindings: Array<{ integration_id: string; profile_id: number | null }> =
              bindingsRaw ? JSON.parse(bindingsRaw) : [];
            const binding = bindings.find((b) => b.integration_id === integrationId);
            if (binding?.profile_id) {
              attributionProfileId = binding.profile_id;
              const objectNames = await getObjectListForIntegration(
                deps.repo,
                integrationId,
              );
              const fleet = loadFleet(deps.repo);
              const machine = fleet.find((m) => m.integration_id === integrationId);
              const created = deps.repo.materializeAcceptedPrinterLink({
                kind: "create",
                profileId: binding.profile_id,
                objectNames,
                fallbackFilename: status.filename,
                link: {
                  integrationId,
                  printerId: machine?.id ?? integrationId,
                  hostName: integrationSummary.name,
                  filename: normalizePrinterFilename(status.filename) || status.filename,
                  started: false,
                },
              });
              if (created.kind === "created") createdLinks.push(created.link);
            }
          } catch (error) {
            if (error instanceof AcceptedPlanOperationalIntegrityError) {
              request.log.error(
                {
                  failure: "integrity",
                  code: error.code,
                  ...(attributionProfileId == null
                    ? {}
                    : { profileId: attributionProfileId }),
                  integrationId,
                },
                "Accepted printer auto-attribution failed",
              );
            } else {
              request.log.error(
                {
                  failure: "unexpected",
                  ...(attributionProfileId == null
                    ? {}
                    : { profileId: attributionProfileId }),
                  integrationId,
                },
                "Accepted printer auto-attribution failed",
              );
            }
          }
        }
      }

      // Keep `applied` alias empty for older clients; prefer `updates`.
      return {
        status,
        updates,
        created_links: createdLinks,
        applied: [],
        unattributed: openUnattributed,
      };
    },
  );

  app.post(
    "/printer-checkoff/verify",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body as { link_id?: string; decisions?: unknown };
      const linkId = String(body.link_id ?? "").trim();
      if (!linkId) {
        return sendProblem(reply, 400, "Bad Request", "link_id is required");
      }
      let result;
      try {
        result = verifyPrinterCheckoff(deps.repo, linkId, body.decisions);
      } catch (error) {
        if (error instanceof AcceptedPlanOperationalIntegrityError) {
          request.log.error(
            { code: error.code, linkId },
            "Accepted Plan integrity failure",
          );
          return sendProblem(
            reply,
            500,
            "Internal Server Error",
            "Accepted Plan data is inconsistent",
          );
        }
        request.log.error(
          { failure: "unexpected", linkId },
          "Accepted printer verification failed",
        );
        return sendProblem(reply, 500, "Internal Server Error", "Internal Server Error");
      }
      if ("error" in result) {
        return sendProblem(
          reply,
          result.status,
          result.status === 404
            ? "Not Found"
            : result.status === 409
              ? "Conflict"
              : result.status === 503
                ? "Service Unavailable"
                : "Bad Request",
          result.error,
        );
      }

      // Dispatch print.verified / print.rejected webhooks for confirmed and rejected units.
      const { link, units_confirmed, units_rejected } = result;
      claimMatchingUnattributedPrints(deps.repo, link);
      const webhookBase = {
        link_id: link.id,
        profile_id: link.profile_id,
        filename: link.filename,
        integration_id: link.integration_id,
      };
      if (units_confirmed > 0) {
        void dispatchWebhooks(deps.repo, "print.verified", {
          ...webhookBase,
          units_confirmed,
        });
      }
      if (units_rejected > 0) {
        void dispatchWebhooks(deps.repo, "print.rejected", {
          ...webhookBase,
          units_rejected,
        });
      }

      // Best-effort: deduct consumed filament from Spoolman when units are confirmed.
      if (units_confirmed > 0) {
        const rawDecisions = (request.body as { decisions?: unknown }).decisions;
        const confirmedDecisions = Array.isArray(rawDecisions)
          ? rawDecisions.filter(
              (d): d is { part_id: number; unit_index: number; result: "confirmed" } =>
                !!d &&
                typeof d === "object" &&
                (d as { result?: unknown }).result === "confirmed" &&
                typeof (d as { part_id?: unknown }).part_id === "number" &&
                typeof (d as { unit_index?: unknown }).unit_index === "number",
            )
          : [];
        void deductSpoolmanFilamentAfterVerify(
          deps.repo,
          link.integration_id,
          link.profile_id,
          confirmedDecisions,
          link.units.length,
        );
      }

      return result;
    },
  );

  app.post(
    "/printer-checkoff/dismiss",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body as { link_id?: string };
      const linkId = String(body.link_id ?? "").trim();
      if (!linkId) {
        return sendProblem(reply, 400, "Bad Request", "link_id is required");
      }
      const result = dismissHostFailedLink(deps.repo, linkId);
      if ("error" in result) {
        return sendProblem(
          reply,
          result.status,
          result.status === 404 ? "Not Found" : "Conflict",
          result.error,
        );
      }
      return { link: result };
    },
  );

  app.post(
    "/printer-checkoff/file-assignments",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body as {
        profile_id?: unknown;
        printer_id?: unknown;
        filename?: unknown;
        remote_path?: unknown;
        object_names?: unknown;
        tracking?: unknown;
        completed?: unknown;
        sliced_3mf_confirmed?: unknown;
      };
      const profileId = Number(body.profile_id);
      const printerId = typeof body.printer_id === "string" ? body.printer_id.trim() : "";
      const filename = typeof body.filename === "string" ? body.filename.trim() : "";
      const tracking = body.tracking === "manual" ? "manual" : "host";
      if (!Number.isInteger(profileId) || profileId <= 0) {
        return sendProblem(reply, 400, "Bad Request", "profile_id is required");
      }
      if (!printerId) return sendProblem(reply, 400, "Bad Request", "printer_id is required");
      if (!filename || filename.length > 500) {
        return sendProblem(reply, 400, "Bad Request", "filename is required");
      }
      if (!/\.(?:gcode|gco|bgcode|3mf)$/i.test(filename)) {
        return sendProblem(
          reply,
          400,
          "Bad Request",
          "Choose a .gcode, .gco, .bgcode, or .3mf print file",
        );
      }
      if (/\.3mf$/i.test(filename) && body.sliced_3mf_confirmed !== true) {
        return sendProblem(
          reply,
          400,
          "Bad Request",
          "Confirm that the 3MF is sliced and print-ready",
        );
      }
      const printer = loadFleet(deps.repo).find((row) => row.id === printerId);
      if (!printer) return sendProblem(reply, 404, "Not Found", "Printer not found");
      const objectNames = Array.isArray(body.object_names)
        ? body.object_names
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim().slice(0, 200))
            .filter(Boolean)
            .slice(0, 500)
        : [];
      const remotePath = typeof body.remote_path === "string" && body.remote_path.trim()
        ? body.remote_path.trim().slice(0, 1_000)
        : undefined;

      let integrationId: string;
      if (tracking === "manual") {
        integrationId = `manual:${printer.id}`;
      } else {
        integrationId = printer.integration_id?.trim() ?? "";
        const integration = integrationId
          ? getIntegrationConfig(deps.repo, integrationId)
          : null;
        if (!integration || integration.config.enabled === false) {
          return sendProblem(
            reply,
            409,
            "Conflict",
            "Use manual tracking because this printer has no available host",
          );
        }
      }

      let materialized: ReturnType<AppRepository["materializeAcceptedPrinterLink"]>;
      try {
        materialized = deps.repo.materializeAcceptedPrinterLink({
          kind: "create",
          profileId,
          objectNames,
          fallbackFilename: filename,
          link: {
            integrationId,
            printerId: printer.id,
            hostName: printer.name,
            filename,
            remotePath,
            started: false,
          },
        });
      } catch (error) {
        if (error instanceof AcceptedPlanOperationalIntegrityError) {
          request.log.error(
            { failure: "integrity", code: error.code, profileId, printerId },
            "Print file assignment failed",
          );
        } else {
          request.log.error(
            { failure: "unexpected", profileId, printerId },
            "Print file assignment failed",
          );
        }
        return sendProblem(reply, 500, "Internal Server Error", "Internal Server Error");
      }

      if (materialized.kind === "created") {
        if (body.completed !== true) {
          return { link: materialized.link, attribution: materialized.attribution };
        }
        const completed = updatePrinterCheckoffLink(
          deps.repo,
          materialized.link.id,
          {
            state: "awaiting_verify",
            host_outcome: "success",
            saw_active: true,
            last_progress: 100,
            completed_at: new Date().toISOString(),
          },
          { requireState: "watching" },
        );
        if (!completed) {
          return sendProblem(reply, 409, "Conflict", "Print assignment changed; retry");
        }
        return { link: completed, attribution: materialized.attribution };
      }
      switch (materialized.kind) {
        case "transaction_unavailable":
          return sendProblem(reply, 503, "Service Unavailable", "Accepted Plan update is unavailable");
        case "empty":
          return sendProblem(reply, 409, "Conflict", "Accepted Plan has no required units");
        case "accepted_state_unavailable":
          return sendProblem(
            reply,
            409,
            "Conflict",
            materialized.reason === "compatibility_dirty"
              ? "Accepted Plan requires compatibility repair"
              : "Accepted Plan operational state is not initialized",
          );
        case "no_match":
          return sendProblem(
            reply,
            409,
            "Conflict",
            "Print file does not map to an incomplete Required unit in this Build",
          );
        case "already_linked":
          return sendProblem(reply, 409, "Conflict", "This print file is already assigned");
        default:
          request.log.error(
            { failure: "unexpected", profileId, printerId, outcome: materialized.kind },
            "Print file assignment failed",
          );
          return sendProblem(reply, 500, "Internal Server Error", "Internal Server Error");
      }
    },
  );

  app.post(
    "/printer-checkoff/:id/manual-complete",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const link = getPrinterCheckoffLink(deps.repo, id);
      if (!link) return sendProblem(reply, 404, "Not Found", "Tracked print not found");
      if (link.integration_id !== `manual:${link.printer_id}`) {
        return sendProblem(reply, 409, "Conflict", "This print is monitored by its printer host");
      }
      const completed = updatePrinterCheckoffLink(
        deps.repo,
        id,
        {
          state: "awaiting_verify",
          host_outcome: "success",
          saw_active: true,
          last_progress: 100,
          completed_at: new Date().toISOString(),
        },
        { requireState: "watching" },
      );
      if (!completed) {
        return sendProblem(reply, 409, "Conflict", "Tracked print is no longer waiting to finish");
      }
      return { link: completed };
    },
  );

  app.get("/printer-outcomes/summary", async (request, reply) => {
    const query = request.query as { profile_id?: string };
    const profileId = Number(query.profile_id);
    if (!Number.isInteger(profileId) || profileId <= 0) {
      return sendProblem(reply, 400, "Bad Request", "profile_id is required");
    }
    return summarizePrintOutcomes(deps.repo, profileId);
  });

  // --- Unattributed prints routes ---

  app.get("/printer-checkoff/unattributed", async () => {
    const prints = filterLinkedUnattributedPrints(
      listOpenUnattributedPrints(deps.repo),
      loadPrinterCheckoffLinks(deps.repo),
    );
    return { prints };
  });

  app.post(
    "/printer-checkoff/unattributed/:id/claim",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        profile_id?: unknown;
        selected_stl_basenames?: unknown;
      };
      const profileId = Number(body.profile_id);
      if (!Number.isInteger(profileId) || profileId <= 0) {
        return sendProblem(reply, 400, "Bad Request", "profile_id is required");
      }
      const selectedStlBasenames = Array.isArray(body.selected_stl_basenames)
        ? body.selected_stl_basenames
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
        : null;

      const allPrints = listUnattributedPrints(deps.repo);
      const print = allPrints.find((p) => p.id === id);
      if (!print) {
        return sendProblem(reply, 404, "Not Found", "Unattributed print not found");
      }
      if (print.claimed_at) {
        return sendProblem(reply, 409, "Conflict", "Print already claimed");
      }

      let objectNames: string[] | undefined;
      if (selectedStlBasenames != null) {
        if (selectedStlBasenames.length === 0) {
          return sendProblem(reply, 400, "Bad Request", "Select at least one plate file");
        }
        const selected = new Set(selectedStlBasenames);
        const grouped = groupObjectsByPart(print.gcode_objects);
        objectNames = [...grouped.values()]
          .filter((group) => selected.has(group.stlBasename.toLowerCase()))
          .flatMap((group) => group.objects.map((object) => object.name));
        if (objectNames.length === 0) {
          return sendProblem(reply, 400, "Bad Request", "Selected files are not on this plate");
        }
      }

      let materialized: ReturnType<AppRepository["materializeAcceptedPrinterLink"]>;
      try {
        materialized = deps.repo.materializeAcceptedPrinterLink({
          kind: "claim",
          profileId,
          expectedPrint: print,
          objectNames,
        });
      } catch (error) {
        if (error instanceof AcceptedPlanOperationalIntegrityError) {
          request.log.error(
            { failure: "integrity", code: error.code, profileId, printId: print.id },
            "Accepted printer claim failed",
          );
        } else {
          request.log.error(
            { failure: "unexpected", profileId, printId: print.id },
            "Accepted printer claim failed",
          );
        }
        return sendProblem(reply, 500, "Internal Server Error", "Internal Server Error");
      }
      switch (materialized.kind) {
        case "claimed":
          return { link: materialized.link, ok: true };
        case "transaction_unavailable":
          return sendProblem(
            reply,
            503,
            "Service Unavailable",
            "Accepted Plan update is unavailable",
          );
        case "empty":
          return sendProblem(reply, 409, "Conflict", "Accepted Plan has no required units");
        case "accepted_state_unavailable":
          return sendProblem(
            reply,
            409,
            "Conflict",
            materialized.reason === "compatibility_dirty"
              ? "Accepted Plan requires compatibility repair"
              : "Accepted Plan operational state is not initialized",
          );
        case "no_match":
          return sendProblem(
            reply,
            409,
            "Conflict",
            "Print does not map to an incomplete accepted Plan unit",
          );
        case "already_linked":
          return sendProblem(reply, 409, "Conflict", "Print is already linked");
        case "print_changed":
          return sendProblem(
            reply,
            409,
            "Conflict",
            "Print changed or was already claimed",
          );
        default:
          request.log.error(
            { failure: "unexpected", profileId, printId: print.id },
            "Accepted printer claim failed",
          );
          return sendProblem(reply, 500, "Internal Server Error", "Internal Server Error");
      }
    },
  );

  app.post(
    "/printer-checkoff/unattributed/:id/dismiss",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = dismissUnattributedPrint(deps.repo, id);
      if (!ok) {
        return sendProblem(reply, 404, "Not Found", "Unattributed print not found");
      }
      return { ok: true };
    },
  );
}

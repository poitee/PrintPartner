import { existsSync } from "node:fs";
import type { PrinterHostStatus, PrinterSendQueueItem } from "@print-partner/contracts";
import type { PrinterMachine } from "@print-partner/domain";
import type { AppRepository } from "../db/repository.js";
import { getIntegrationConfig } from "../integrations/store.js";
import { loadFleet } from "./printer-fleet.js";
import {
  assertPrinterUploadArtifactPath,
  getPrinterSendQueueItem,
  listActivePrinterSendQueue,
  updatePrinterSendQueueItem,
} from "./printer-send-queue-store.js";

export type StartPrinterUploadJob = (payload: {
  printer_id: string;
  artifact_path: string;
  filename: string;
  start: boolean;
  host_name?: string;
  profile_id?: number;
  checkoff_units?: PrinterSendQueueItem["checkoff_units"];
}) => Promise<string>;

export type GetHostStatus = (integrationId: string) => Promise<PrinterHostStatus>;

function isIdleish(state: PrinterHostStatus["state"]): boolean {
  return state === "idle" || state === "complete";
}

async function resolveDispatchTarget(
  repo: AppRepository,
  item: PrinterSendQueueItem,
  preferred: PrinterMachine,
  deps: {
    getStatus: GetHostStatus;
    force?: boolean;
    excludePrinterIds?: Set<string>;
  },
): Promise<
  | { printer: PrinterMachine; hostName: string; integrationId: string }
  | { error: string; status: number }
> {
  if (deps.excludePrinterIds?.has(preferred.id)) {
    return { error: "Printer already claimed this drain pass", status: 409 };
  }

  const integrationId = preferred.integration_id?.trim();
  if (!integrationId) {
    return { error: "Printer is not linked to a host", status: 400 };
  }
  const integration = getIntegrationConfig(repo, integrationId);
  if (!integration) return { error: "Linked host not found", status: 400 };
  if (integration.type !== "moonraker" && integration.type !== "prusalink") {
    return { error: `Upload is not supported for ${integration.type}`, status: 400 };
  }
  if (item.wait_for_idle && !deps.force) {
    try {
      const status = await deps.getStatus(integrationId);
      if (!isIdleish(status.state)) {
        return {
          error: `Printer is ${status.state} — wait for Idle or force dispatch`,
          status: 409,
        };
      }
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        status: 409,
      };
    }
  }
  return { printer: preferred, hostName: integration.name, integrationId };
}

/**
 * Dispatch a queued send when the queued Printer is idle (or force=true).
 * Claims the item as sending, starts printer-upload job, stores job id.
 * Never reassigns the sliced file to another Printer.
 */
export async function dispatchPrinterSendQueueItem(
  repo: AppRepository,
  exportsDir: string,
  itemId: string,
  deps: {
    startJob: StartPrinterUploadJob;
    getStatus: GetHostStatus;
    force?: boolean;
    excludePrinterIds?: Set<string>;
  },
): Promise<
  | { item: PrinterSendQueueItem; job_id: string }
  | { error: string; status: number }
> {
  const item = getPrinterSendQueueItem(repo, itemId);
  if (!item) return { error: "Queue item not found", status: 404 };
  if (item.state !== "queued" && item.state !== "error") {
    return { error: "Item is not dispatchable", status: 409 };
  }

  let artifactPath: string;
  try {
    artifactPath = assertPrinterUploadArtifactPath(exportsDir, item.artifact_path);
  } catch {
    return { error: "Invalid artifact path", status: 400 };
  }
  if (!existsSync(artifactPath)) {
    updatePrinterSendQueueItem(
      repo,
      item.id,
      { state: "error", error: "Artifact file missing on disk" },
      { requireState: ["queued", "error"] },
    );
    return { error: "Artifact file missing on disk", status: 409 };
  }

  const preferred = loadFleet(repo).find((m) => m.id === item.printer_id);
  if (!preferred) return { error: "Fleet printer not found", status: 404 };

  const target = await resolveDispatchTarget(repo, item, preferred, deps);
  if ("error" in target) return target;

  const claimed = updatePrinterSendQueueItem(
    repo,
    item.id,
    {
      state: "sending",
      error: undefined,
      printer_id: target.printer.id,
      host_name: target.hostName,
    },
    { requireState: ["queued", "error"], requireNoSendingForPrinter: target.printer.id },
  );
  if (!claimed) return { error: "Item changed concurrently", status: 409 };

  try {
    const job_id = await deps.startJob({
      printer_id: target.printer.id,
      artifact_path: artifactPath,
      filename: item.filename,
      start: item.start,
      host_name: target.hostName,
      profile_id: item.profile_id,
      checkoff_units: item.checkoff_units,
    });
    const updated = updatePrinterSendQueueItem(repo, item.id, {
      upload_job_id: job_id,
    });
    return { item: updated ?? claimed, job_id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    updatePrinterSendQueueItem(repo, item.id, {
      state: "error",
      error: message.slice(0, 500),
    });
    return { error: message, status: 500 };
  }
}

/** Max queue items examined in one HTTP drain request (status checks can be slow). */
export const DRAIN_ITEM_CAP = 8;

/**
 * For each waiting queue item, dispatch to its queued Printer when that host is idle.
 * At most one send per printer per drain pass. Bounded by {@link DRAIN_ITEM_CAP}.
 */
export async function drainPrinterSendQueue(
  repo: AppRepository,
  exportsDir: string,
  deps: {
    startJob: StartPrinterUploadJob;
    getStatus: GetHostStatus;
  },
  options: { printerId?: string } = {},
): Promise<Array<{ item_id: string; job_id?: string; error?: string }>> {
  const queued = listActivePrinterSendQueue(repo).filter(
    (item) =>
      item.state === "queued" &&
      (options.printerId === undefined || item.printer_id === options.printerId),
  );
  const results: Array<{ item_id: string; job_id?: string; error?: string }> = [];
  const usedPrinters = new Set<string>();

  for (const item of queued.slice(0, DRAIN_ITEM_CAP)) {
    let dispatched: Awaited<ReturnType<typeof dispatchPrinterSendQueueItem>>;
    try {
      dispatched = await dispatchPrinterSendQueueItem(repo, exportsDir, item.id, {
        startJob: deps.startJob,
        getStatus: deps.getStatus,
        force: !item.wait_for_idle,
        excludePrinterIds: usedPrinters,
      });
    } catch (e) {
      results.push({
        item_id: item.id,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if ("error" in dispatched) {
      if (dispatched.status === 409) continue;
      results.push({ item_id: item.id, error: dispatched.error });
      continue;
    }
    usedPrinters.add(dispatched.item.printer_id);
    results.push({ item_id: item.id, job_id: dispatched.job_id });
  }

  return results;
}

/** Mark queue items done/error from finished printer-upload jobs. */
export function reconcileSendQueueJobResult(
  repo: AppRepository,
  jobId: string,
  result: { ok: boolean; message?: string },
): void {
  const all = listActivePrinterSendQueue(repo);
  const item = all.find((i) => i.upload_job_id === jobId && i.state === "sending");
  if (!item) return;
  updatePrinterSendQueueItem(
    repo,
    item.id,
    result.ok
      ? { state: "done", error: undefined }
      : { state: "error", error: (result.message ?? "Upload failed").slice(0, 500) },
    { requireState: "sending" },
  );
}

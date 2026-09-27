import type {
  PrinterCheckoffUnit,
  PrinterSendQueueItem,
} from "@print-partner/contracts";
import { resolveEngineUrl } from "../contractRequest";
import { engineFetch, engineFetchMultipart } from "../engineTransport";

type BambuConnectHandoffResult = {
  handoff_id: string;
  filename: string;
  absolute_path: string;
  connect_url: string;
  launched: boolean;
  launch_error?: string;
  in_container: boolean;
  download_path: string;
  checkoff_link_id?: string;
  checkoff_units?: number;
  message: string;
};

function appendCheckoffFields(
  form: FormData,
  options: { profile_id?: number; checkoff_units?: PrinterCheckoffUnit[] },
): void {
  if (options.profile_id != null) {
    form.append("profile_id", String(options.profile_id));
  }
  if (options.checkoff_units && options.checkoff_units.length > 0) {
    form.append("checkoff_units", JSON.stringify(options.checkoff_units));
  }
}

export async function fetchPrinterSendQueue(options?: {
  active?: boolean;
}): Promise<{ items: PrinterSendQueueItem[] }> {
  const qs = options?.active ? "?active=1" : "";
  return engineFetch(`/printer-send-queue${qs}`);
}

export async function dispatchPrinterSendQueueItem(options: {
  id: string;
  force?: boolean;
}): Promise<{ item: PrinterSendQueueItem; job_id: string }> {
  return engineFetch(`/printer-send-queue/${encodeURIComponent(options.id)}/dispatch`, {
    method: "POST",
    body: JSON.stringify({ force: Boolean(options.force) }),
  });
}

export async function drainPrinterSendQueue(options?: {
  printer_id: string;
}): Promise<{
  results: Array<{ item_id: string; job_id?: string; error?: string }>;
}> {
  return engineFetch(`/printer-send-queue/drain`, {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
}

export async function cancelPrinterSendQueueItem(id: string): Promise<{ item: PrinterSendQueueItem }> {
  return engineFetch(`/printer-send-queue/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Stage a sliced 3MF/G-code and hand off via official bambu-connect:// URL scheme. */
export async function startBambuConnectHandoff(options: {
  file: File;
  printer_id?: string;
  launch?: boolean;
  profile_id?: number;
  checkoff_units?: PrinterCheckoffUnit[];
}): Promise<BambuConnectHandoffResult> {
  const form = new FormData();
  form.append("file", options.file);
  if (options.printer_id) form.append("printer_id", options.printer_id);
  if (options.launch === false) form.append("launch", "0");
  else if (options.launch === true) form.append("launch", "1");
  appendCheckoffFields(form, options);
  return engineFetchMultipart<BambuConnectHandoffResult>({
    path: "/bambu-connect/handoff",
    form,
    failureMessage: "Bambu Connect handoff failed",
  });
}

export function bambuConnectDownloadUrl(downloadPath: string): string {
  return resolveEngineUrl(downloadPath);
}

export async function startPrinterUpload(options: {
  file: File;
  printer_id: string;
  start?: boolean;
  profile_id?: number;
  checkoff_units?: PrinterCheckoffUnit[];
  unlabeled_names?: string[];
}): Promise<string> {
  const form = new FormData();
  form.append("file", options.file);
  form.append("printer_id", options.printer_id);
  form.append("start", options.start ? "1" : "0");
  appendCheckoffFields(form, options);
  if (options.unlabeled_names && options.unlabeled_names.length > 0) {
    form.append("unlabeled_names", JSON.stringify(options.unlabeled_names));
  }
  const body = await engineFetchMultipart<{ job_id?: string }>({
    path: "/jobs/printer-upload",
    form,
    failureMessage: "Printer upload failed",
  });
  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!jobId) throw new Error("Printer upload failed: missing job_id");
  return jobId;
}

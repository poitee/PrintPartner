import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { moonrakerAdapter } from "../integrations/adapters/moonraker.js";
import { getIntegrationAdapter } from "../integrations/registry.js";
import { createIntegrationPort } from "../integrations/store.js";
import { createJobRunner } from "./job-runner.js";
import { saveFleet } from "./printer-fleet.js";
import {
  INTERRUPTED_PRINTER_SEND_ERROR,
  dispatchPrinterSendQueueItem,
  drainPrinterSendQueue,
  interruptInFlightPrinterSends,
} from "./printer-send-queue.js";
import { enqueuePrinterSend, getPrinterSendQueueItem } from "./printer-send-queue-store.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pp-upload-shutdown-"));
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const repo = ports.repository;
  const integrations = createIntegrationPort({ repo, getAdapter: getIntegrationAdapter });
  const integration = integrations.create({
    type: "moonraker",
    name: "Fixture host",
    config: { base_url: "http://127.0.0.1:1", enabled: true },
  });
  saveFleet(repo, [{
    id: "fixture-printer",
    name: "Fixture",
    model: "Fixture",
    bed_width_mm: 250,
    bed_depth_mm: 250,
    bed_height_mm: 250,
    margin_mm: 5,
    max_filament_slots: 1,
    loaded_filaments: [],
    integration_id: integration.id,
  }]);
  const jobs = createJobRunner(() => repo, dir);
  const exportsDir = jobs.getExportsDir("default");
  cleanup.push(async () => {
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network request"))));
  const upload = vi.spyOn(moonrakerAdapter, "uploadFile");
  const artifact = "; shutdown upload fixture\n";

  function enqueue(id: string, start = false) {
    const artifactDir = join(exportsDir, "printer-uploads", id);
    mkdirSync(artifactDir, { recursive: true });
    const path = join(artifactDir, "plate.gcode");
    writeFileSync(path, artifact);
    const item = enqueuePrinterSend(repo, {
      filename: "plate.gcode",
      artifact_path: path,
      printer_id: "fixture-printer",
      start,
      wait_for_idle: true,
      match: "pinned",
    });
    if (!item) throw new Error("Fixture queue item was not created");
    return item;
  }

  const dispatchDeps = {
    startJob: (payload: Parameters<typeof jobs.start>[1]) => jobs.start("printer-upload", payload, "default"),
    getStatus: async () => ({ state: "idle" as const }),
  };

  return { repo, jobs, exportsDir, upload, artifact, enqueue, dispatchDeps };
}

describe("printer upload interrupted by shutdown", () => {
  it("does not mark the send successful or start it again", async () => {
    const f = await fixture();
    const item = f.enqueue("inflight", true);
    let finishUpload: (result: { ok: true; started: true; remote_path: string }) => void = () => {
      throw new Error("Upload gate was not created");
    };
    f.upload.mockReturnValueOnce(new Promise((resolve) => {
      finishUpload = resolve;
    }));

    const dispatched = await dispatchPrinterSendQueueItem(f.repo, f.exportsDir, item.id, f.dispatchDeps);
    if ("error" in dispatched) throw new Error(dispatched.error);
    await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());

    const interrupted = interruptInFlightPrinterSends(f.repo);
    expect(interrupted.map((row) => row.id)).toEqual([item.id]);
    expect(getPrinterSendQueueItem(f.repo, item.id)).toMatchObject({
      state: "error",
      error: INTERRUPTED_PRINTER_SEND_ERROR,
      upload_job_id: dispatched.job_id,
    });
    expect(getPrinterSendQueueItem(f.repo, item.id)?.state).not.toBe("done");

    finishUpload({ ok: true, started: true, remote_path: "plate.gcode" });
    const terminal = await f.jobs.waitForTerminal(dispatched.job_id, 3000, "default");

    expect(terminal.status).toBe("error");
    expect(terminal.error).toBe(INTERRUPTED_PRINTER_SEND_ERROR);
    expect(getPrinterSendQueueItem(f.repo, item.id)?.state).toBe("error");
    expect(existsSync(item.artifact_path)).toBe(true);
    expect(readFileSync(item.artifact_path, "utf8")).toBe(f.artifact);
    expect(f.upload).toHaveBeenCalledTimes(1);

    expect(await drainPrinterSendQueue(f.repo, f.exportsDir, f.dispatchDeps)).toEqual([]);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(getPrinterSendQueueItem(f.repo, item.id)?.state).toBe("error");

    f.upload.mockResolvedValueOnce({ ok: true, started: true, remote_path: "plate.gcode" });
    const retried = await dispatchPrinterSendQueueItem(f.repo, f.exportsDir, item.id, f.dispatchDeps);
    if ("error" in retried) throw new Error(retried.error);
    expect((await f.jobs.waitForTerminal(retried.job_id, 3000, "default")).status).toBe("done");
    expect(f.upload).toHaveBeenCalledTimes(2);
    expect(getPrinterSendQueueItem(f.repo, item.id)?.state).toBe("done");
  });
});

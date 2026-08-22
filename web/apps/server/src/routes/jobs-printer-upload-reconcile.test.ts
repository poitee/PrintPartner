import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "../db/repository.js";
import { InProcessJobRunner } from "../routes/jobs.js";
import {
  enqueuePrinterSend,
  loadPrinterSendQueue,
  updatePrinterSendQueueItem,
} from "../services/printer-send-queue-store.js";

vi.mock("../services/printer-upload-job.js", () => ({
  runPrinterUploadJob: vi.fn(),
}));

import { runPrinterUploadJob } from "../services/printer-upload-job.js";

const runPrinterUploadJobMock = vi.mocked(runPrinterUploadJob);

function memoryRepo(): AppRepository {
  const settings = new Map<string, string>();
  return {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string) => {
      settings.set(k, v);
    },
    transaction: <T>(fn: () => T) => fn(),
  } as unknown as AppRepository;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

describe("printer-upload job failure reconcile", () => {
  let dataDir: string;
  let repo: AppRepository;
  let runner: InProcessJobRunner;
  let releaseUpload: () => void;
  let uploadGate: Promise<void>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-job-reconcile-"));
    repo = memoryRepo();
    uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    runPrinterUploadJobMock.mockReset();
    runPrinterUploadJobMock.mockImplementation(async () => {
      await uploadGate;
      throw new Error("upload boom");
    });
    runner = new InProcessJobRunner({
      getRepo: () => repo,
      reposDir: join(dataDir, "repos"),
      exportsDir: join(dataDir, "exports"),
      dataDir,
    });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reconciles send-queue out of sending even when emit listeners throw", async () => {
    // QA / CodeRabbit major: reconcile shared the emit try/catch, so a throwing
    // subscriber left the queue item stuck in "sending".
    const staged = enqueuePrinterSend(repo, {
      filename: "plate.gcode",
      artifact_path: join(dataDir, "exports", "printer-uploads", "x", "plate.gcode"),
      printer_id: "p1",
      start: false,
      wait_for_idle: false,
      match: "pinned",
    });
    expect(staged).toBeTruthy();

    const jobId = await runner.start("printer-upload", {
      printer_id: "p1",
      filename: "plate.gcode",
      absolute_path: staged!.artifact_path,
    });

    updatePrinterSendQueueItem(
      repo,
      staged!.id,
      { state: "sending", upload_job_id: jobId },
      { requireState: "queued" },
    );

    runner.subscribe(jobId, "default", (event) => {
      if (event.status === "error") {
        throw new Error("subscriber boom during emit");
      }
    });

    releaseUpload();

    await waitFor(() => {
      const item = loadPrinterSendQueue(repo).find((i) => i.id === staged!.id);
      return item?.state === "error";
    });

    const item = loadPrinterSendQueue(repo).find((i) => i.id === staged!.id)!;
    expect(item.state).toBe("error");
    expect(item.error).toMatch(/upload boom/);
  });
});

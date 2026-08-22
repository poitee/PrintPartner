import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppRepository } from "../db/repository.js";
import { InProcessJobRunner } from "./jobs.js";

const dirs: string[] = [];

function createRunner(options?: {
  completedJobMax?: number;
  completedJobGlobalMax?: number;
  completedJobRetentionMs?: number;
}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-jobs-tenant-"));
  dirs.push(dataDir);
  const repo = {
    getSetting: () => null,
  } as unknown as AppRepository;
  return new InProcessJobRunner(
    {
      getRepo: () => repo,
      reposDir: join(dataDir, "repos"),
      exportsDir: join(dataDir, "exports"),
      dataDir,
    },
    options,
  );
}

async function waitForTerminal(
  runner: InProcessJobRunner,
  jobId: string,
  tenantId: string,
): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const snapshot = await runner.get(jobId, tenantId);
    if (snapshot?.status === "done" || snapshot?.status === "error") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${jobId} did not finish`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("InProcessJobRunner tenant ownership", () => {
  it("rejects an unknown internal job kind without retaining a snapshot", async () => {
    const runner = createRunner();

    await expect(
      Reflect.apply(runner.start, runner, ["removed-job", {}, "tenant-a"]),
    ).rejects.toThrow("Unsupported job kind: removed-job");
    expect(runner.listJobs({}, "tenant-a")).toEqual([]);
  });

  it("hides get, list, and subscribe from a different tenant", async () => {
    const runner = createRunner();
    const jobId = await runner.start("sync", {}, "tenant-a");
    await waitForTerminal(runner, jobId, "tenant-a");

    expect(await runner.get(jobId, "tenant-a")).not.toBeNull();
    expect(await runner.get(jobId, "tenant-b")).toBeNull();
    expect(runner.listJobs({}, "tenant-a").map((job) => job.job_id)).toContain(jobId);
    expect(runner.listJobs({}, "tenant-b")).toEqual([]);
    expect(runner.subscribe(jobId, "tenant-b", () => undefined)).toBeNull();
    expect(runner.subscribe(jobId, "tenant-a", () => undefined)).toBeTypeOf("function");
  });

  it("evicts the oldest terminal snapshots while retaining active jobs", async () => {
    const runner = createRunner({
      completedJobMax: 2,
      completedJobRetentionMs: 60_000,
    });
    const first = await runner.start("sync", {}, "tenant-a");
    const second = await runner.start("sync", {}, "tenant-a");
    const third = await runner.start("sync", {}, "tenant-a");
    await waitForTerminal(runner, third, "tenant-a");

    const retained = runner.listJobs({}, "tenant-a");
    expect(retained).toHaveLength(2);
    expect(retained.map((job) => job.job_id)).not.toContain(first);
    expect(retained.map((job) => job.job_id)).toContain(second);
    expect(await runner.get(first, "tenant-a")).toBeNull();
  });

  it("applies the terminal cap independently per tenant without counting active jobs", async () => {
    const runner = createRunner({
      completedJobMax: 2,
      completedJobRetentionMs: 60_000,
    });
    const originalRunJob = (
      runner as unknown as {
        runJob: (
          jobId: string,
          kind: string,
          payload: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).runJob.bind(runner);
    (
      runner as unknown as {
        runJob: (
          jobId: string,
          kind: string,
          payload: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).runJob = async (jobId, kind, payload) => {
      if (payload.active === true) return new Promise<void>(() => undefined);
      return originalRunJob(jobId, kind, payload);
    };

    const activeA = await runner.start("sync", { active: true }, "tenant-a");
    const activeB = await runner.start("sync", { active: true }, "tenant-b");
    const completedA = await Promise.all([
      runner.start("sync", {}, "tenant-a"),
      runner.start("sync", {}, "tenant-a"),
      runner.start("sync", {}, "tenant-a"),
    ]);
    await waitForTerminal(runner, completedA[2]!, "tenant-a");
    const completedB = await Promise.all([
      runner.start("sync", {}, "tenant-b"),
      runner.start("sync", {}, "tenant-b"),
      runner.start("sync", {}, "tenant-b"),
    ]);
    await waitForTerminal(runner, completedB[2]!, "tenant-b");

    const tenantA = runner.listJobs({}, "tenant-a");
    const tenantB = runner.listJobs({}, "tenant-b");
    expect(tenantA).toHaveLength(3);
    expect(tenantA.map((job) => job.job_id)).toContain(activeA);
    expect(tenantA.filter((job) => job.status === "error")).toHaveLength(2);
    expect(tenantB).toHaveLength(3);
    expect(tenantB.map((job) => job.job_id)).toContain(activeB);
    expect(tenantB.filter((job) => job.status === "error")).toHaveLength(2);
  });

  it("applies the per-tenant cap to jobs with an empty tenant id", async () => {
    const runner = createRunner({
      completedJobMax: 2,
      completedJobGlobalMax: 10,
      completedJobRetentionMs: 60_000,
    });
    const jobs = await Promise.all([
      runner.start("sync", {}, ""),
      runner.start("sync", {}, ""),
      runner.start("sync", {}, ""),
    ]);
    await waitForTerminal(runner, jobs[2]!, "");

    expect(runner.listJobs({}, "")).toHaveLength(2);
    expect(await runner.get(jobs[0]!, "")).toBeNull();
  });

  it("enforces a global terminal ceiling across tenant buckets", async () => {
    const runner = createRunner({
      completedJobMax: 3,
      completedJobGlobalMax: 3,
      completedJobRetentionMs: 60_000,
    });
    const tenantA = await Promise.all([
      runner.start("sync", {}, "tenant-a"),
      runner.start("sync", {}, "tenant-a"),
    ]);
    await waitForTerminal(runner, tenantA[1]!, "tenant-a");
    const tenantB = await Promise.all([
      runner.start("sync", {}, "tenant-b"),
      runner.start("sync", {}, "tenant-b"),
    ]);
    await waitForTerminal(runner, tenantB[1]!, "tenant-b");

    const retained = [
      ...runner.listJobs({}, "tenant-a"),
      ...runner.listJobs({}, "tenant-b"),
    ];
    expect(retained).toHaveLength(3);
    expect(retained.map((job) => job.job_id)).not.toContain(tenantA[0]);
  });
});

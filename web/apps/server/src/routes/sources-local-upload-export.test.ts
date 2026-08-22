import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.PRINT_PARTNER_DATA_DIR;
});

function multipartFiles(files: Array<{ name: string; content: Buffer }>) {
  const boundary = "----pp-test-boundary";
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="relative_paths"\r\n\r\n` +
        `${JSON.stringify(files.map((f) => f.name))}\r\n`,
    ),
  );
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(file.content);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function waitJob(app: Awaited<ReturnType<typeof buildApp>>, jobId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const job = (
      await app.inject({ method: "GET", url: `/jobs/${jobId}` })
    ).json() as { status?: string; result?: { file_total?: number } };
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("export job timed out");
}

describe("local upload Source revisions", () => {
  it("lets accepted STL export copy a verified upload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-local-upload-export-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);
    cleanups.push(async () => {
      await app.close();
      await ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const created = await app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Smoke Source", source_kind: "local" },
    });
    expect(created.statusCode).toBe(200);
    const sourceId = (created.json() as { id: number }).id;
    const { payload, headers } = multipartFiles([
      { name: "cube.stl", content: Buffer.from("solid cube\nendsolid cube\n") },
    ]);
    const uploaded = await app.inject({
      method: "POST",
      url: `/sources/${sourceId}/upload-files`,
      payload,
      headers,
    });
    expect(uploaded.statusCode).toBe(200);
    const source = uploaded.json() as {
      current_source_revision_id?: number;
      local_path?: string;
      stl_count?: number;
    };
    expect(source.stl_count).toBe(1);
    expect(source.current_source_revision_id).toEqual(expect.any(Number));
    expect(source.local_path).toContain(`/repos/${sourceId}/revisions/`);
    expect(existsSync(join(source.local_path!, "cube.stl"))).toBe(true);

    const plan = await app.inject({
      method: "POST",
      url: "/plans",
      payload: { name: "smoke-test-plan" },
    });
    const planId = (plan.json() as { id: number }).id;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/plans/${planId}/layers/base`,
          payload: { project_id: sourceId },
        })
      ).statusCode,
    ).toBe(200);

    const draft = (
      await app.inject({
        method: "POST",
        url: `/plans/${planId}/drafts/recompute`,
        headers: { "idempotency-key": "upload-recompute" },
        payload: { apply_manifest: true },
      })
    ).json() as {
      reconciliation?: { kind?: string };
      draft: {
        draft_id: number;
        snapshot_digest: string;
        lifecycle_version: number;
        base: Record<string, unknown>;
      };
    };
    expect(draft.reconciliation?.kind).toBe("ready");
    const applied = await app.inject({
      method: "POST",
      url: `/plans/${planId}/drafts/${draft.draft.draft_id}/apply`,
      headers: { "idempotency-key": "upload-apply" },
      payload: {
        expected_snapshot_digest: draft.draft.snapshot_digest,
        expected_lifecycle_version: draft.draft.lifecycle_version,
        expected_base: draft.draft.base,
      },
    });
    expect(applied.statusCode).toBe(200);

    const exportRes = await app.inject({
      method: "POST",
      url: "/jobs/export-stl-pack",
      payload: { profile_id: planId },
    });
    expect(exportRes.statusCode).toBe(200);
    const job = await waitJob(app, (exportRes.json() as { job_id: string }).job_id);
    expect(job.status).toBe("done");
    expect(job.result?.file_total).toBe(1);
  });
});

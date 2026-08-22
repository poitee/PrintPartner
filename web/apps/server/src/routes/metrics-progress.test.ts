import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import {
  AppRepository,
  type AcceptedProfileProgress,
  type AcceptedProfileSummary,
} from "../db/repository.js";
import { getLogger } from "../services/logger.js";
import { registerMetricsRoutes } from "./metrics.js";

const roots: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-metrics-progress-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  databases.push(database);
  return new AppRepository(getDb(database), undefined, database.reposDir);
}

function summary(
  repo: AppRepository,
  name: string,
  progress: AcceptedProfileProgress,
  archived = false,
): AcceptedProfileSummary {
  const profile = repo.createProfile(name);
  const header = repo.getProfileHeader(profile.id);
  if (!header) throw new Error("test Profile header is missing");
  return {
    header: { ...header, archived_at: archived ? "2026-08-21T12:00:00.000Z" : null },
    progress,
  };
}

async function metrics(repo: AppRepository): Promise<string> {
  const app = Fastify();
  await registerMetricsRoutes(app, {
    repo,
    validateApiKey: () => true,
    version: "test",
  });
  const response = await app.inject({ method: "GET", url: "/metrics" });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.body;
}

describe("accepted Plan Progress metrics", () => {
  it("emits one bounded state per active Plan and remaining counts only for ready", async () => {
    const repo = fixture();
    const summaries = [
      summary(repo, 'A "ready"', { kind: "ready", totalUnits: 4, remainingUnits: 2 }),
      summary(repo, "B ready zero", { kind: "ready", totalUnits: 0, remainingUnits: 0 }),
      summary(repo, "C empty", { kind: "empty" }),
      summary(repo, "D dirty", { kind: "unavailable", reason: "compatibility_dirty" }),
      summary(repo, "E uninitialized", { kind: "unavailable", reason: "uninitialized" }),
      summary(repo, "F integrity", { kind: "integrity_failure", code: "revision_digest" }),
      summary(repo, "G concurrent", { kind: "concurrent_update" }),
      summary(repo, "H archived", { kind: "ready", totalUnits: 1, remainingUnits: 1 }, true),
    ];
    repo.listAcceptedProfileSummaries = () => summaries;

    const body = await metrics(repo);
    expect(body).toContain("plan_progress_collection_available 1");
    expect(body.match(/^plan_progress_state\{/gm)).toHaveLength(7);
    expect(body).toContain(
      'plan_progress_state{plan_id="1",plan_name="A \\"ready\\"",state="ready"} 1',
    );
    expect(body).toContain('state="empty"} 1');
    expect(body).toContain('state="compatibility_dirty"} 1');
    expect(body).toContain('state="uninitialized"} 1');
    expect(body).toContain('state="integrity"} 1');
    expect(body).toContain('state="concurrent_update"} 1');
    expect(body.match(/^parts_remaining\{/gm)).toHaveLength(2);
    expect(body).toContain('plan_name="A \\"ready\\""} 2');
    expect(body).toContain('plan_name="B ready zero"} 0');
    expect(body).not.toContain("H archived");
    expect(body).not.toContain("revision_digest");
  });

  it("keeps unrelated metrics and emits only collection availability on failure", async () => {
    const repo = fixture();
    repo.listAcceptedProfileSummaries = () => {
      throw new Error("secret SQL /private/path token_123");
    };
    const log = vi.spyOn(getLogger(), "log").mockImplementation(() => undefined);

    const body = await metrics(repo);
    expect(body).toContain("plates_sent_total 0");
    expect(body).toContain("plan_progress_collection_available 0");
    expect(body).not.toContain("plan_progress_state{");
    expect(body).not.toContain("parts_remaining{");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret SQL");
    expect(log).toHaveBeenCalledWith(
      "error",
      "[metrics] Accepted Plan progress collection unavailable",
      { failure: "unexpected", operation: "metrics_plan_progress" },
    );
  });

  it("escapes quotes, backslashes, and newlines in Plan labels", async () => {
    const repo = fixture();
    repo.listAcceptedProfileSummaries = () => [
      summary(repo, 'A "quote" \\path\nnext', {
        kind: "ready",
        totalUnits: 2,
        remainingUnits: 1,
      }),
    ];

    const body = await metrics(repo);
    const escapedLabel = 'plan_name="A \\"quote\\" \\\\path\\nnext"';
    expect(body).toContain(`plan_progress_state{plan_id="1",${escapedLabel},state="ready"} 1`);
    expect(body).toContain(`parts_remaining{plan_id="1",${escapedLabel}} 1`);
    expect(body).not.toContain('A "quote" \\path\nnext');
  });
});

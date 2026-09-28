import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationSummary, PrintVerifyDecision } from "@print-partner/contracts";
import { acceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { deductSpoolmanFilamentAfterVerify } from "./spoolman-deduct.js";

describe("Spoolman deduction connector ownership", () => {
  let dir: string;
  let sqlite: SqliteDatabase;
  let repo: AppRepository;
  let server: Server;
  let baseUrl: string;
  let profileId: number;
  let deductions: Array<{ path: string; body: unknown }>;
  let printerReads: number;

  beforeEach(async () => {
    deductions = [];
    printerReads = 0;
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/printer/printer/objects/query?print_stats") {
        printerReads += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ result: { status: { print_stats: { filament_used: 1200 } } } }));
        return;
      }
      if (req.method === "PUT" && req.url?.endsWith("/api/v1/spool/7/use")) {
        req.setEncoding("utf8");
        let body = "";
        for await (const chunk of req) body += chunk;
        deductions.push({ path: req.url, body: JSON.parse(body) });
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test connector has no TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    dir = mkdtempSync(join(tmpdir(), "pp-spoolman-deduct-"));
    sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "Spool deduction fixture", url: "https://github.com/example/fixture" });
    const sourcePath = join(dir, "repos", String(source.id));
    mkdirSync(join(sourcePath, "parts"), { recursive: true });
    writeFileSync(join(sourcePath, "parts", "first.stl"), "solid first");
    writeFileSync(join(sourcePath, "parts", "second.stl"), "solid second");
    repo.updateSource(source.id, { local_path: sourcePath });
    repo.updateImportRules(source.id, ["parts/"]);
    profileId = repo.createProfile("Spool deduction fixture", source.id).id;
    acceptPlanForTest(repo, profileId);
  });

  afterEach(async () => {
    sqlite?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  function integration(
    id: string,
    type: IntegrationSummary["type"],
    updatedAt: string,
    enabled = true,
  ): IntegrationSummary {
    return {
      id,
      type,
      name: id,
      config: { base_url: `${baseUrl}/${id}`, enabled },
      created_at: updatedAt,
      updated_at: updatedAt,
    };
  }

  function saveIntegrations(spoolIntegrations: IntegrationSummary[]): void {
    repo.setSetting("integrations", JSON.stringify([
      integration("printer", "moonraker", "2026-09-01T00:00:00Z"),
      ...spoolIntegrations,
    ]));
  }

  function assignSpools(owners: string[]): PrintVerifyDecision[] {
    const accepted = repo.readAcceptedPlanOperationalSnapshot(profileId);
    if (accepted.kind !== "ready") throw new Error("Test Plan is not ready");
    return owners.map((owner, index) => {
      const part = accepted.snapshot.parts[index];
      if (!part) throw new Error("Test Plan part is missing");
      const result = repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(accepted.snapshot),
        target: { kind: "part", projectionPartId: part.projectionPartId },
        assignment: {
          color: { kind: "catalog", colorId: `spoolman:${owner}:filament:3` },
          spoolmanSpoolId: `spoolman:${owner}:spool:7`,
        },
      });
      if (result.kind !== "updated") throw new Error(`Test assignment failed: ${result.kind}`);
      return { part_id: part.projectionPartId, unit_index: 0, result: "confirmed" };
    });
  }

  it("deducts matching numeric spool ids from their own connectors", async () => {
    saveIntegrations([
      integration("older", "spoolman", "2026-09-01T00:00:00Z"),
      integration("newer", "spoolman", "2026-09-02T00:00:00Z"),
    ]);
    const decisions = assignSpools(["older", "newer"]);

    await deductSpoolmanFilamentAfterVerify(repo, "printer", profileId, decisions, 2);

    expect(printerReads).toBe(1);
    expect(deductions).toEqual([
      { path: "/older/api/v1/spool/7/use", body: { use_length: 600 } },
      { path: "/newer/api/v1/spool/7/use", body: { use_length: 600 } },
    ]);
  });

  it.each([
    { owner: "disabled", type: "spoolman", enabled: false },
    { owner: "wrong-type", type: "moonraker", enabled: true },
    { owner: "deleted", type: null, enabled: true },
  ] satisfies Array<{ owner: string; type: IntegrationSummary["type"] | null; enabled: boolean }>)(
    "skips a $owner spool owner without falling back to another connector",
    async ({ owner, type, enabled }) => {
      saveIntegrations([
        integration("unrelated", "spoolman", "2026-09-01T00:00:00Z"),
        ...(type ? [integration(owner, type, "2026-09-02T00:00:00Z", enabled)] : []),
      ]);
      const decisions = assignSpools([owner]);

      await deductSpoolmanFilamentAfterVerify(repo, "printer", profileId, decisions, 1);

      expect(printerReads).toBe(1);
      expect(deductions).toEqual([]);
    },
  );

  it("does not redistribute a disabled owner's share to an enabled connector", async () => {
    saveIntegrations([
      integration("enabled", "spoolman", "2026-09-01T00:00:00Z"),
      integration("disabled", "spoolman", "2026-09-02T00:00:00Z", false),
    ]);
    const decisions = assignSpools(["enabled", "disabled"]);

    await deductSpoolmanFilamentAfterVerify(repo, "printer", profileId, decisions, 4);

    expect(printerReads).toBe(1);
    expect(deductions).toEqual([
      { path: "/enabled/api/v1/spool/7/use", body: { use_length: 300 } },
    ]);
  });
});

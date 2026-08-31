import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";

function requiredName(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return value.name;
  }
  throw new Error("Response did not include name");
}

function planNames(value: unknown): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("profiles" in value) ||
    !Array.isArray(value.profiles)
  ) {
    throw new Error("Plan list response did not include profiles");
  }
  return value.profiles.map(requiredName);
}

describe("live backup restore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("keeps repository reads usable after replacing the SQLite database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-live-restore-"));
    dirs.push(dataDir);
    const config = { ...loadConfig(), dataDir };
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      await app.inject({
        method: "POST",
        url: "/plans",
        payload: { name: "Before backup" },
      });
      const backupResponse = await app.inject({ method: "POST", url: "/backups" });
      expect(backupResponse.statusCode).toBe(201);
      const backupName = requiredName(backupResponse.json());

      await app.inject({
        method: "POST",
        url: "/plans",
        payload: { name: "After backup" },
      });
      const restoreResponse = await app.inject({
        method: "POST",
        url: "/backups/restore",
        payload: { backupName },
      });
      expect(restoreResponse.statusCode).toBe(200);

      const plansResponse = await app.inject({ method: "GET", url: "/plans" });
      expect(plansResponse.statusCode).toBe(200);
      expect(planNames(plansResponse.json())).toEqual(["Before backup"]);
    } finally {
      await app.close();
      await ports.db.close();
    }
  });
});

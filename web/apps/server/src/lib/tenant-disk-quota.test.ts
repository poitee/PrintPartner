import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_TENANT_DISK_QUOTA_BYTES } from "@print-partner/contracts";
import { tenantExportDirectory } from "./secure-path.js";
import { sourceWorkspaceRoot } from "../services/source-filesystem-policy.js";
import {
  assertTenantDiskHeadroom,
  measureTenantDiskUsage,
  TenantDiskQuotaError,
} from "./tenant-disk-quota.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tenant disk quota", () => {
  it("counts tenant exports and source workspaces", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-quota-"));
    dirs.push(dataDir);
    const reposDir = join(dataDir, "repos");
    const exportsDir = tenantExportDirectory(join(dataDir, "exports"), "tenant-a");
    mkdirSync(exportsDir, { recursive: true });
    mkdirSync(sourceWorkspaceRoot(reposDir, 1), { recursive: true });
    writeFileSync(join(exportsDir, "kit.zip"), "x".repeat(100));
    writeFileSync(join(sourceWorkspaceRoot(reposDir, 1), "part.stl"), "y".repeat(50));

    const used = await measureTenantDiskUsage({
      dataDir,
      reposDir,
      tenantId: "tenant-a",
      sourceIds: [1],
    });
    expect(used).toBe(150);
  });

  it("refuses additional bytes that would pass the quota", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-quota-full-"));
    dirs.push(dataDir);
    const reposDir = join(dataDir, "repos");
    await expect(
      assertTenantDiskHeadroom({
        dataDir,
        reposDir,
        tenantId: "tenant-a",
        sourceIds: [],
        additionalBytes: HOSTED_TENANT_DISK_QUOTA_BYTES + 1,
        quotaBytes: HOSTED_TENANT_DISK_QUOTA_BYTES,
      }),
    ).rejects.toBeInstanceOf(TenantDiskQuotaError);
  });
});

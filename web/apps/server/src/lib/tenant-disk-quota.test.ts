import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_TENANT_DISK_QUOTA_BYTES } from "@print-partner/contracts";
import { tenantExportDirectory } from "./secure-path.js";
import { sourceWorkspaceRoot } from "../services/source-filesystem-policy.js";
import {
  chargeTenantDiskBytes,
  runWithTenantDiskQuota,
  withoutTenantDiskQuota,
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
    mkdirSync(join(dataDir, "sources", "1", "files"), { recursive: true });
    mkdirSync(join(dataDir, "sources", "2"), { recursive: true });
    writeFileSync(join(exportsDir, "kit.zip"), "x".repeat(100));
    writeFileSync(join(sourceWorkspaceRoot(reposDir, 1), "part.stl"), "y".repeat(50));
    writeFileSync(join(dataDir, "sources", "1", "upload.zip"), "z".repeat(25));
    writeFileSync(join(dataDir, "sources", "1", "files", "part.stl"), "y".repeat(50));
    writeFileSync(join(dataDir, "sources", "2", "upload.zip"), "other tenant");

    const used = await measureTenantDiskUsage({
      dataDir,
      reposDir,
      tenantId: "tenant-a",
      sourceIds: [1],
    });
    expect(used).toBe(225);
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

function quotaFixture(tenantId = "tenant-a") {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-quota-serial-"));
  dirs.push(dataDir);
  return { dataDir, reposDir: join(dataDir, "repos"), tenantId, sourceIds: () => [], quotaBytes: 10 };
}

it("serializes same-tenant writes and rescans retained bytes before the next writer", async () => {
  const input = quotaFixture();
  const root = tenantExportDirectory(join(input.dataDir, "exports"), input.tenantId);
  mkdirSync(root, { recursive: true });
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = runWithTenantDiskQuota(input, async () => {
    chargeTenantDiskBytes(6);
    entered();
    await barrier;
    writeFileSync(join(root, "first"), "123456");
  });
  await ready;
  let secondEntered = false;
  const second = runWithTenantDiskQuota(input, async () => {
    secondEntered = true;
    chargeTenantDiskBytes(6);
    writeFileSync(join(root, "second"), "123456");
  });
  const refused = expect(second).rejects.toBeInstanceOf(TenantDiskQuotaError);
  await runWithTenantDiskQuota({ ...input, tenantId: "tenant-b" }, async () => chargeTenantDiskBytes(10));
  expect(secondEntered).toBe(false);
  release();
  await first;
  await refused;
  expect(await measureTenantDiskUsage({ ...input, sourceIds: [] })).toBe(6);
  await runWithTenantDiskQuota(input, async () => chargeTenantDiskBytes(4));
});

it("counts temporary writes conservatively and clears the budget for subsequent operations", async () => {
  const input = quotaFixture();
  await runWithTenantDiskQuota(input, async () => {
    chargeTenantDiskBytes(7);
    expect(() => chargeTenantDiskBytes(4)).toThrow(TenantDiskQuotaError);
    chargeTenantDiskBytes(3);
  });
  await runWithTenantDiskQuota(input, async () => chargeTenantDiskBytes(10));
  await runWithTenantDiskQuota({ ...input, quotaBytes: null }, async () => chargeTenantDiskBytes(1000));
});

it("detaches scheduled child jobs so they acquire a fresh budget after the parent", async () => {
  const input = quotaFixture();
  let child: Promise<void> | undefined;
  await runWithTenantDiskQuota(input, async () => {
    chargeTenantDiskBytes(10);
    child = withoutTenantDiskQuota(() => new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        runWithTenantDiskQuota(input, async () => chargeTenantDiskBytes(10)).then(resolve, reject);
      });
    }));
  });
  await child;
});

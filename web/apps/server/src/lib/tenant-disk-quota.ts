import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyReply } from "fastify";
import { HOSTED_TENANT_DISK_QUOTA_BYTES } from "@print-partner/contracts";
import { sendProblem } from "./api-error.js";
import { tenantExportDirectory } from "./secure-path.js";
import { sourceWorkspaceRoot } from "../services/source-filesystem-policy.js";

export const TENANT_DISK_QUOTA_DETAIL =
  "This tenant is at the 2 GiB disk quota on the hosted planning site.";

export class TenantDiskQuotaError extends Error {
  constructor() {
    super(TENANT_DISK_QUOTA_DETAIL);
    this.name = "TenantDiskQuotaError";
  }
}

type PathUsage = Readonly<{ bytes: number }>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function measureDirectoryBytes(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (stats.isSymbolicLink()) return 0;
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;

  let usage: PathUsage = { bytes: 0 };
  let entries;
  try {
    entries = await readdir(path);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  for (const name of entries) {
    const child = await measureDirectoryBytes(join(path, name));
    const bytes = usage.bytes + child;
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("Tenant disk usage exceeds the supported numeric range");
    }
    usage = { bytes };
  }
  return usage.bytes;
}

export async function measureTenantDiskUsage(input: {
  dataDir: string;
  reposDir: string;
  tenantId: string;
  sourceIds: readonly number[];
}): Promise<number> {
  const exportBytes = await measureDirectoryBytes(
    tenantExportDirectory(join(input.dataDir, "exports"), input.tenantId),
  );
  let sourceBytes = 0;
  for (const sourceId of input.sourceIds) {
    sourceBytes += await measureDirectoryBytes(sourceWorkspaceRoot(input.reposDir, sourceId));
  }
  const total = exportBytes + sourceBytes;
  if (!Number.isSafeInteger(total)) {
    throw new Error("Tenant disk usage exceeds the supported numeric range");
  }
  return total;
}

export async function assertTenantDiskHeadroom(input: {
  dataDir: string;
  reposDir: string;
  tenantId: string;
  sourceIds: readonly number[];
  additionalBytes?: number;
  quotaBytes: number;
}): Promise<void> {
  const used = await measureTenantDiskUsage(input);
  const additional = Math.max(0, input.additionalBytes ?? 0);
  if (used + additional > input.quotaBytes) {
    throw new TenantDiskQuotaError();
  }
}

export async function sendIfTenantDiskQuotaExceeded(
  reply: FastifyReply,
  input: {
    dataDir: string;
    reposDir: string;
    tenantId: string;
    sourceIds: readonly number[];
    additionalBytes?: number;
    quotaBytes: number | null;
  },
): Promise<boolean> {
  if (input.quotaBytes == null) return false;
  try {
    await assertTenantDiskHeadroom({
      dataDir: input.dataDir,
      reposDir: input.reposDir,
      tenantId: input.tenantId,
      sourceIds: input.sourceIds,
      additionalBytes: input.additionalBytes,
      quotaBytes: input.quotaBytes,
    });
    return false;
  } catch (error) {
    if (error instanceof TenantDiskQuotaError) {
      sendProblem(reply, 413, "Payload Too Large", error.message);
      return true;
    }
    throw error;
  }
}

export { HOSTED_TENANT_DISK_QUOTA_BYTES };

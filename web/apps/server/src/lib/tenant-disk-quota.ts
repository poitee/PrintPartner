import { readdir, lstat } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
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

type DiskBudget = { remaining: number; active: boolean };
const diskBudget = new AsyncLocalStorage<DiskBudget | undefined>();
const tenantWrites = new Map<string, Promise<void>>();

/** Count new bytes before writing, including temporary copies. Renames cost no bytes. */
export function chargeTenantDiskBytes(bytes: number): void {
  const budget = diskBudget.getStore();
  if (!budget) return;
  if (!budget.active) throw new Error("Tenant disk write outlived its quota operation");
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid disk write size");
  if (bytes > budget.remaining) throw new TenantDiskQuotaError();
  budget.remaining -= bytes;
}

export function withoutTenantDiskQuota<T>(work: () => T): T {
  return diskBudget.run(undefined, work);
}

/** One writer per tenant. Rescan after each operation, counting abandoned staging too. */
export async function runWithTenantDiskQuota<T>(input: {
  dataDir: string;
  reposDir: string;
  tenantId: string;
  sourceIds: () => readonly number[];
  quotaBytes: number | null;
}, work: () => Promise<T>): Promise<T> {
  if (input.quotaBytes == null) return withoutTenantDiskQuota(work);
  if (diskBudget.getStore()) throw new Error("Nested tenant disk quota operation");
  const key = JSON.stringify([resolve(input.dataDir), input.tenantId]);
  const previous = tenantWrites.get(key);
  let release!: () => void;
  const current = new Promise<void>((done) => { release = done; });
  tenantWrites.set(key, current);
  try {
    await previous;
    const used = await measureTenantDiskUsage({ ...input, sourceIds: input.sourceIds() });
    const budget: DiskBudget = { remaining: Math.max(0, input.quotaBytes - used), active: true };
    try {
      return await diskBudget.run(budget, work);
    } finally {
      budget.active = false;
    }
  } finally {
    release();
    if (tenantWrites.get(key) === current) tenantWrites.delete(key);
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
    sourceBytes += await measureDirectoryBytes(join(input.dataDir, "sources", String(sourceId)));
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

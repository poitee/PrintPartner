import type { JobSnapshot } from "@print-partner/contracts";

/** Persistence layer (SQLite in self-host, managed DB in SaaS). */
export interface DbStore {
  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

/** Blob / file storage (local FS in self-host, object store in SaaS). */
export interface StoragePort {
  resolvePath(relativePath: string): string;
  exists(relativePath: string): Promise<boolean>;
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, contents: string): Promise<void>;
}

export type JobKind = string;

export interface JobRunner {
  start(kind: JobKind, payload: Record<string, unknown>, tenantId?: string): Promise<string>;
  get(jobId: string, tenantId: string): Promise<JobSnapshot | null>;
  cancel(jobId: string, tenantId: string): Promise<boolean>;
}

/** External system connectors (Moonraker, Spoolman, etc.) — see integrations/store.ts. */

export interface AppPorts {
  db: DbStore;
  storage: StoragePort;
  jobs: JobRunner;
}

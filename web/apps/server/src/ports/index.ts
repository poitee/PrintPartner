import type { JobSnapshot } from "@print-partner/contracts";

/** Persistence layer (SQLite in self-host, managed DB in SaaS). */
export interface DbStore {
  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
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
  jobs: JobRunner;
}

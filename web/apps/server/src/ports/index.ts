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

/** GitHub / local folder source sync. */
export interface RepoSource {
  listSources(): Promise<Array<{ id: number; name: string }>>;
  syncSource(sourceId: number): Promise<void>;
}

/** Authentication and tenant resolution. */
export interface AuthProvider {
  /** Returns tenant id for the current request, or null when unauthenticated. */
  resolveTenant(request: { headers: Record<string, string | string[] | undefined> }): Promise<string | null>;
}

export type JobKind = string;

export interface JobRunner {
  start(kind: JobKind, payload: Record<string, unknown>, tenantId?: string): Promise<string>;
  get(jobId: string, tenantId: string): Promise<JobSnapshot | null>;
  cancel(jobId: string, tenantId: string): Promise<boolean>;
}

export type { AssistantPort } from "../assistant/types.js";

/** External system connectors (Moonraker, Spoolman, etc.) — see integrations/store.ts. */
export type { IntegrationPort } from "../integrations/store.js";

export interface AppPorts {
  db: DbStore;
  storage: StoragePort;
  repoSource: RepoSource;
  auth: AuthProvider;
  jobs: JobRunner;
}

import { HOSTED_TENANT_DISK_QUOTA_BYTES } from "@print-partner/contracts";
import { join } from "node:path";
import type { DbStore, JobRunner, StoragePort } from "../../ports/index.js";
import {
  closeBundle,
  connectBundle,
  openDatabaseBundle,
  pingBundle,
  repositoryForTenant,
  type DatabaseBundle,
} from "../../db/database.js";
import { createJobRunner } from "../../services/job-runner.js";
import type { AppRepository } from "../../db/repository.js";
import { SaasS3StoragePort, TenantLocalStoragePort } from "./storage-s3.js";

export class SaasDbStore implements DbStore {
  readonly bundle: DatabaseBundle;
  defaultRepository: AppRepository | null = null;

  constructor(
    readonly dataDir: string,
    readonly databaseUrl: string | null,
  ) {
    this.bundle = openDatabaseBundle(dataDir, databaseUrl, "saas");
    this.defaultRepository =
      this.bundle.driver === "postgres" && this.databaseUrl ? null : this.bundle.repository;
  }

  async connect(): Promise<void> {
    await connectBundle(this.bundle);
    this.defaultRepository = this.bundle.repository;
  }

  async close(): Promise<void> {
    await closeBundle(this.bundle);
  }

  async ping(): Promise<boolean> {
    const status = await pingBundle(this.bundle);
    if (this.databaseUrl) return status.app && status.postgres === true;
    return status.app;
  }

  repositoryFor(tenantId: string): AppRepository {
    return repositoryForTenant(this.bundle, tenantId);
  }
}

type SaasPorts = {
  db: SaasDbStore;
  storage: StoragePort;
  jobs: JobRunner;
  getRepository: (tenantId: string) => AppRepository;
  reposDir: string;
  sourcesDir: string;
  dataDir: string;
};

export function createSaasPorts(dataDir: string): SaasPorts {
  const databaseUrl = process.env.DATABASE_URL ?? null;
  const s3Bucket = process.env.S3_BUCKET ?? null;
  const dbStore = new SaasDbStore(dataDir, databaseUrl);
  const defaultTenant = "default";

  const getRepository = (tenantId: string) => dbStore.repositoryFor(tenantId || defaultTenant);

  const getRepo = () => getRepository(defaultTenant);

  const jobs = createJobRunner(getRepo, dataDir, { tenantDiskQuotaBytes: HOSTED_TENANT_DISK_QUOTA_BYTES });

  const storage = s3Bucket
    ? new SaasS3StoragePort(
        s3Bucket,
        defaultTenant,
        dataDir,
        process.env.S3_REGION ?? process.env.AWS_REGION,
      )
    : new TenantLocalStoragePort(dataDir, defaultTenant);

  return {
    db: dbStore,
    storage,
    jobs,
    getRepository,
    reposDir: join(dataDir, "repos"),
    sourcesDir: join(dataDir, "sources"),
    dataDir,
  };
}

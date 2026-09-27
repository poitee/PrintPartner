import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbStore, JobRunner, StoragePort } from "../../ports/index.js";
import { getDb, SqliteDatabase } from "../../db/client.js";
import { AppRepository } from "../../db/repository.js";
import { createJobRunner } from "../../services/job-runner.js";
import {
  TRUSTED_SINGLE_USER_SOURCE_FILESYSTEM,
  type SourceFilesystemPolicy,
} from "../../services/source-filesystem-policy.js";

export class SelfHostDbStore implements DbStore {
  readonly sqlite: SqliteDatabase;
  repository: AppRepository | null = null;

  constructor(
    readonly dataDir: string,
    private readonly sourceFilesystemPolicy: SourceFilesystemPolicy,
  ) {
    this.sqlite = new SqliteDatabase(dataDir);
  }

  async connect(): Promise<void> {
    this.sqlite.connect();
    this.repository = new AppRepository(getDb(this.sqlite), undefined, this.sqlite.reposDir, undefined, {
      sourceFilesystemPolicy: this.sourceFilesystemPolicy,
    });
  }

  async close(): Promise<void> {
    this.sqlite.close();
    this.repository = null;
  }

  async ping(): Promise<boolean> {
    return this.sqlite.ping();
  }
}

class SelfHostStoragePort implements StoragePort {
  constructor(private readonly rootDir: string) {}

  resolvePath(relativePath: string): string {
    return join(this.rootDir, relativePath.replace(/^\/+/, ""));
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await access(this.resolvePath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(this.resolvePath(relativePath), "utf8");
  }

  async writeText(relativePath: string, contents: string): Promise<void> {
    const full = this.resolvePath(relativePath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}

type SelfHostPorts = {
  db: SelfHostDbStore;
  storage: SelfHostStoragePort;
  jobs: JobRunner;
  repository: AppRepository;
  reposDir: string;
  sourcesDir: string;
};

export function createSelfHostPorts(
  dataDir: string,
  sourceFilesystemPolicy: SourceFilesystemPolicy = TRUSTED_SINGLE_USER_SOURCE_FILESYSTEM,
): SelfHostPorts {
  const dbStore = new SelfHostDbStore(dataDir, sourceFilesystemPolicy);
  const getRepo = () => {
    if (!dbStore.repository) throw new Error("Database not connected");
    return dbStore.repository;
  };

  const jobs = createJobRunner(getRepo, dataDir);

  return {
    db: dbStore,
    storage: new SelfHostStoragePort(dataDir),
    jobs,
    get repository() {
      return getRepo();
    },
    reposDir: join(dataDir, "repos"),
    sourcesDir: join(dataDir, "sources"),
  };
}

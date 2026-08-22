import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobSnapshot } from "@print-partner/contracts";
import type { AuthProvider, DbStore, JobRunner, RepoSource, StoragePort } from "../../ports/index.js";
import { getDb, SqliteDatabase } from "../../db/client.js";
import { AppRepository } from "../../db/repository.js";
import { createJobRunner } from "../../routes/jobs.js";

export class SelfHostDbStore implements DbStore {
  readonly sqlite: SqliteDatabase;
  repository: AppRepository | null = null;

  constructor(readonly dataDir: string) {
    this.sqlite = new SqliteDatabase(dataDir);
  }

  async connect(): Promise<void> {
    this.sqlite.connect();
    this.repository = new AppRepository(getDb(this.sqlite), undefined, this.sqlite.reposDir);
  }

  async close(): Promise<void> {
    this.sqlite.close();
    this.repository = null;
  }

  async ping(): Promise<boolean> {
    return this.sqlite.ping();
  }
}

export class SelfHostStoragePort implements StoragePort {
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

export class SelfHostRepoSource implements RepoSource {
  constructor(private readonly getRepo: () => AppRepository) {}

  async listSources(): Promise<Array<{ id: number; name: string }>> {
    return this.getRepo().listSources().map((s) => ({ id: s.id, name: s.name }));
  }

  async syncSource(sourceId: number): Promise<void> {
    const { syncProjectById } = await import("../../routes/sources.js");
    const repo = this.getRepo();
    await syncProjectById(repo, repo.reposDir, sourceId);
  }
}

export class SelfHostAuthProvider implements AuthProvider {
  async resolveTenant(): Promise<string | null> {
    return "default";
  }
}

export type SelfHostPorts = {
  db: SelfHostDbStore;
  storage: SelfHostStoragePort;
  repoSource: RepoSource;
  auth: AuthProvider;
  jobs: JobRunner;
  repository: AppRepository;
  reposDir: string;
  sourcesDir: string;
};

export function createSelfHostPorts(dataDir: string): SelfHostPorts {
  const dbStore = new SelfHostDbStore(dataDir);
  const getRepo = () => {
    if (!dbStore.repository) throw new Error("Database not connected");
    return dbStore.repository;
  };

  const jobs = createJobRunner(getRepo, dataDir);

  return {
    db: dbStore,
    storage: new SelfHostStoragePort(dataDir),
    repoSource: new SelfHostRepoSource(getRepo),
    auth: new SelfHostAuthProvider(),
    jobs,
    get repository() {
      return getRepo();
    },
    reposDir: join(dataDir, "repos"),
    sourcesDir: join(dataDir, "sources"),
  };
}

/** Satisfies JobRunner via InProcessJobRunner */
export type { JobSnapshot };

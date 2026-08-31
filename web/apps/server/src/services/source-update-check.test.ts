import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";

const github = vi.hoisted(() => ({ getCommit: vi.fn() }));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    readonly repos = { getCommit: github.getCommit };
  },
}));

import { checkAllSourceUpdates } from "./source-update-check.js";

const cleanups: Array<() => void> = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pp-source-update-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
}

afterEach(() => {
  vi.clearAllMocks();
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("source update checks", () => {
  it("records one in-app alert when a GitHub source first moves out of date", async () => {
    github.getCommit.mockResolvedValue({ data: { sha: "new-sha" } });
    const repo = makeRepo();
    const source = repo.createSource({
      name: "Tracked repository",
      url: "https://github.com/example/tracked",
      source_kind: "github",
      local_path: join(repo.reposDir, "tracked"),
    });
    repo.markSourceSynced(source.id, "old-sha");

    await expect(checkAllSourceUpdates(repo)).resolves.toMatchObject({
      checked_count: 1,
      updates_available: 1,
    });
    await checkAllSourceUpdates(repo);

    const alerts = repo.listAppEvents({ kinds: ["source.update_available"] });
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0]!.payloadJson ?? "{}")).toMatchObject({
      source_id: source.id,
      source_name: "Tracked repository",
      previous_sha: "old-sha",
    });
  });

  it("does not ask GitHub about tracked model pages", async () => {
    const repo = makeRepo();
    repo.createSource({
      name: "Tracked model",
      url: "https://www.printables.com/model/123-example",
      source_kind: "printables",
      local_path: join(repo.reposDir, "model"),
    });

    await expect(checkAllSourceUpdates(repo)).resolves.toMatchObject({
      checked_count: 0,
      updates_available: 0,
      skipped: [expect.objectContaining({ reason: "not_git" })],
    });
    expect(github.getCommit).not.toHaveBeenCalled();
  });
});

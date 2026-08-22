import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import {
  createApiKey,
  listApiKeys,
  regenerateApiKey,
  validateApiKey,
} from "./api-key-manager.js";

function withRepository(run: (repo: AppRepository) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pp-api-key-manager-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();

  try {
    run(new AppRepository(getDb(sqlite), "default", sqlite.reposDir));
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("API key manager security", () => {
  it("stores settings API keys as non-recoverable digests and only returns plaintext once", () => {
    withRepository((repo) => {
      const created = createApiKey(repo);
      const persisted = repo.getSetting("api_keys_v1")!;

      expect(created.key).toMatch(/^ppk_[a-f0-9]{64}$/);
      expect(created).not.toHaveProperty("keyHash");
      expect(persisted).not.toContain(created.key);
      expect(JSON.parse(persisted)[0].keyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(listApiKeys(repo)[0]).not.toHaveProperty("keyHash");
      expect(listApiKeys(repo)[0]).not.toHaveProperty("key");
    });
  });

  it("rejects an expired settings API key", () => {
    withRepository((repo) => {
      const created = createApiKey(repo);
      const stored = JSON.parse(repo.getSetting("api_keys_v1")!) as Array<{
        expiresAt: string | null;
      }>;
      stored[0]!.expiresAt = new Date(0).toISOString();
      repo.setSetting("api_keys_v1", JSON.stringify(stored));

      expect(validateApiKey(repo, created.key)).toBeNull();
    });
  });

  it("migrates a legacy base64 key to an HMAC digest without invalidating it", () => {
    withRepository((repo) => {
      const rawKey = `ppk_${"a".repeat(64)}`;
      repo.setSetting(
        "api_keys_v1",
        JSON.stringify([
          {
            id: "key_legacy",
            keyHash: Buffer.from(rawKey).toString("base64"),
            createdAt: new Date(0).toISOString(),
            lastUsedAt: null,
            expiresAt: null,
            isActive: true,
          },
        ]),
      );

      expect(validateApiKey(repo, rawKey)).toBe("key_legacy");

      const persisted = repo.getSetting("api_keys_v1")!;
      expect(persisted).not.toContain(Buffer.from(rawKey).toString("base64"));
      expect(JSON.parse(persisted)[0].keyHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("regenerates a key by revoking the original and returning one replacement secret", () => {
    withRepository((repo) => {
      const original = createApiKey(repo);
      const replacement = regenerateApiKey(repo, original.id);

      expect(replacement?.key).toMatch(/^ppk_[a-f0-9]{64}$/);
      expect(replacement).not.toHaveProperty("keyHash");
      expect(validateApiKey(repo, original.key)).toBeNull();
      expect(validateApiKey(repo, replacement!.key)).toBe(replacement!.id);
    });
  });
});

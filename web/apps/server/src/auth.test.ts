import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { DEFAULT_TENANT_ID } from "./db/schema.js";
import { AuthStore } from "./services/auth-store.js";
import { hashPassword, verifyPassword } from "./services/password.js";
import { tenantStorage } from "./middleware/tenant-context.js";
import { buildKitBundleData } from "./services/export-kit.js";
import { migrateLegacySourceManifestOverridesForTenant } from "./services/source-manifest-migration.js";
import {
  findSourceManifestPath,
  legacySourceManifestOverridePath,
  sourceWorkspaceRoot,
} from "./services/source-workspace.js";

describe("password hashing", () => {
  it("hashes and verifies passwords", () => {
    const hash = hashPassword("correct-horse-battery");
    expect(verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("AuthStore", () => {
  it("creates users, sessions, and claims the existing default tenant for the first user", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const db = getDb(sqlite);
    const auth = new AuthStore(db);

    tenantStorage.run("default", () => {
      const repo = new AppRepository(db, "default", sqlite.reposDir);
      repo.createSource({ name: "Legacy", url: "https://github.com/x/y" });
    });

    const hash = hashPassword("password123");
    const user = auth.createUser({
      email: "admin@example.com",
      displayName: "Admin",
      passwordHash: hash,
    });
    expect(user.isAdmin).toBe(true);
    const secondUser = auth.createUser({
      email: "member@example.com",
      displayName: "Member",
      passwordHash: hash,
    });
    expect(secondUser.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(auth.listTenantIds()).toEqual([user.id, secondUser.id].sort());

    tenantStorage.run(user.id, () => {
      const repo = new AppRepository(db, user.id, sqlite.reposDir);
      expect(repo.listSources()).toHaveLength(1);
    });
    tenantStorage.run(secondUser.id, () => {
      const repo = new AppRepository(db, secondUser.id, sqlite.reposDir);
      expect(repo.listSources()).toHaveLength(0);
    });

    const raw = auth.createSession(user.id);
    const session = auth.resolveSession(raw);
    expect(session?.user_id).toBe(user.id);
    expect(session?.tenant_id).toBe(user.id);

    auth.deleteSession(raw);
    expect(auth.resolveSession(raw)).toBeNull();

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a UUID identity when default-tenant claiming is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-no-default-claim-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const auth = new AuthStore(getDb(sqlite), undefined, false);

    const user = auth.createUser({
      email: "single-user@example.com",
      displayName: "Single User",
      passwordHash: hashPassword("password123"),
    });

    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a migrated Source revision readable when the first user claims the default tenant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-source-revision-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const db = getDb(sqlite);
    const auth = new AuthStore(db);
    const repo = new AppRepository(db, "default", sqlite.reposDir);
    const workingTree = join(dir, "working-tree");
    mkdirSync(workingTree, { recursive: true });
    writeFileSync(join(workingTree, "cube.stl"), "solid cube\nendsolid cube\n");
    const source = repo.createSource({
      name: "Legacy Source",
      source_kind: "local",
      local_path: workingTree,
    });
    mkdirSync(sourceWorkspaceRoot(repo.reposDir, source.id), { recursive: true });
    writeFileSync(
      legacySourceManifestOverridePath(repo.reposDir, source.id),
      "project: claimed-source\n",
    );

    await migrateLegacySourceManifestOverridesForTenant(repo, "default");
    const revisionId = repo.getSource(source.id)?.current_source_revision_id;
    expect(revisionId).toEqual(expect.any(Number));

    const user = auth.createUser({
      email: "admin@example.com",
      displayName: "Admin",
      passwordHash: hashPassword("password123"),
    });

    expect(user.id).toBe(DEFAULT_TENANT_ID);
    tenantStorage.run(user.id, () => {
      const claimedRepo = new AppRepository(db, user.id, sqlite.reposDir);
      const claimedSource = claimedRepo.getSource(source.id);
      if (revisionId == null || !claimedSource?.local_path) {
        throw new Error("Claimed Source revision is unavailable");
      }
      expect(claimedSource?.current_source_revision_id).toBe(revisionId);
      expect(claimedRepo.getProjectRow(source.id)?.legacyManifestCutover).toBe(
        true,
      );
      expect(claimedRepo.getSourceRevision(revisionId)).toMatchObject({
        id: revisionId,
        source_id: source.id,
      });
      const manifestPath = findSourceManifestPath(claimedSource.local_path);
      if (!manifestPath) throw new Error("Claimed Source manifest is unavailable");
      expect(readFileSync(manifestPath, "utf8")).toBe("project: claimed-source\n");
    });

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates and accepts plan shares as tenant copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-share-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const db = getDb(sqlite);
    const auth = new AuthStore(db);

    const sender = auth.createUser({
      email: "sender@example.com",
      displayName: "Sender",
      passwordHash: hashPassword("password123"),
    });
    const recipient = auth.createUser({
      email: "recipient@example.com",
      displayName: "Recipient",
      passwordHash: hashPassword("password123"),
    });

    let bundleJson = "";
    tenantStorage.run(sender.id, () => {
      const repo = new AppRepository(db, sender.id, sqlite.reposDir);
      const src = repo.createSource({ name: "Kit", url: "https://github.com/a/b" });
      const plan = repo.createProfile("Voron", src.id);
      const recipe = repo.readEditableKitRecipe(plan.id);
      bundleJson = JSON.stringify(buildKitBundleData({
        mode: { kind: "editable", recipe },
        exportedAt: new Date().toISOString(),
      }));
    });

    const share = auth.createPlanShare({
      fromUserId: sender.id,
      planId: 1,
      planName: "Voron",
      bundleJson,
      recipientEmail: "recipient@example.com",
    });

    const incoming = auth.listIncomingShares("recipient@example.com", recipient.id);
    expect(incoming).toHaveLength(1);

    tenantStorage.run(recipient.id, () => {
      const repo = new AppRepository(db, recipient.id, sqlite.reposDir);
      const row = auth.getShareByToken(share.token)!;
      const result = repo.importKitBundle(JSON.parse(row.bundleJson!) as Record<string, unknown>);
      auth.markShareAccepted(row.id);
      expect(result.profile_name).toBe("Voron");
      expect(repo.listProfileHeaders()).toHaveLength(1);
    });

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resets passwords with single-use tokens and clears sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-reset-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const db = getDb(sqlite);
    const auth = new AuthStore(db);

    const user = auth.createUser({
      email: "reset@example.com",
      displayName: "Reset User",
      passwordHash: hashPassword("old-password"),
    });
    const sessionRaw = auth.createSession(user.id);
    expect(auth.resolveSession(sessionRaw)).not.toBeNull();

    auth.invalidatePasswordResetTokens(user.id);
    const resetRaw = auth.createPasswordResetToken(user.id);
    const userId = auth.consumePasswordResetToken(resetRaw);
    expect(userId).toBe(user.id);
    expect(auth.consumePasswordResetToken(resetRaw)).toBeNull();

    auth.updatePasswordHash(user.id, hashPassword("new-password123"));
    auth.deleteAllUserSessions(user.id);
    expect(auth.resolveSession(sessionRaw)).toBeNull();

    const updated = auth.findUserById(user.id)!;
    expect(verifyPassword("new-password123", updated.passwordHash!)).toBe(true);
    expect(verifyPassword("old-password", updated.passwordHash!)).toBe(false);

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

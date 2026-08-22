import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { AuthStore } from "./services/auth-store.js";
import { hashPassword, verifyPassword } from "./services/password.js";
import { tenantStorage } from "./middleware/tenant-context.js";
import { buildKitBundleData } from "./services/export-kit.js";

describe("password hashing", () => {
  it("hashes and verifies passwords", () => {
    const hash = hashPassword("correct-horse-battery");
    expect(verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("AuthStore", () => {
  it("creates users, sessions, and reassigns default tenant for first user", () => {
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

    tenantStorage.run(user.id, () => {
      const repo = new AppRepository(db, user.id, sqlite.reposDir);
      expect(repo.listSources()).toHaveLength(1);
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

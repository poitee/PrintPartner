import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../services/auth-store.js";
import { getDb, SqliteDatabase } from "./client.js";

describe("sessions.provider migration", () => {
  it("upgrades an old session and rejects an unknown stored provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-session-provider-"));
    try {
      const first = new SqliteDatabase(dir);
      first.connect();
      const auth = new AuthStore(getDb(first));
      const user = auth.createUser({
        email: "legacy@example.com",
        displayName: "Legacy",
        passwordHash: "hash",
      });
      const rawToken = auth.createSession(user.id, "github");
      first.close();

      const path = join(dir, "print-partner.db");
      const old = new Database(path);
      const session = old.prepare("SELECT id,user_id,expires_at FROM sessions").get() as {
        id: string;
        user_id: string;
        expires_at: string;
      };
      old.exec("ALTER TABLE sessions DROP COLUMN provider; DELETE FROM sessions");
      old
        .prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)")
        .run(session.id, session.user_id, session.expires_at);
      old.close();

      const upgraded = new SqliteDatabase(dir);
      upgraded.connect();
      const upgradedAuth = new AuthStore(getDb(upgraded));
      expect(upgradedAuth.resolveSession(rawToken)?.provider).toBe("email");

      const corrupt = new Database(path);
      corrupt.prepare("UPDATE sessions SET provider = 'unknown'").run();
      corrupt.close();
      expect(upgradedAuth.resolveSession(rawToken)).toBeNull();
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

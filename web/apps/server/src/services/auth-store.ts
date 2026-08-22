import { and, eq, gt, sql } from "drizzle-orm";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { DrizzleDb } from "../db/client.js";
import { asSyncDb, type AppDrizzleDb } from "../db/sync-db-bridge.js";
import type { AuthIdentityProvider, SessionUser } from "../routes/auth-types.js";
import * as sqliteSchema from "../db/schema.js";
import * as pgSchema from "../db/schema-pg.js";

export type AuthSchemaBundle = typeof sqliteSchema | typeof pgSchema;

export type DbUser = {
  id: string;
  email: string | null;
  displayName: string;
  passwordHash: string | null;
  isAdmin: boolean;
  createdAt: string;
};

export type PlanShareRow = {
  id: string;
  token: string;
  fromUserId: string;
  fromDisplayName: string;
  planId: number;
  planName: string;
  recipientEmail: string | null;
  status: string;
  createdAt: string;
  bundleJson?: string;
};

const SESSION_DAYS = 14;
const RESET_TOKEN_HOURS = 1;

function hashSessionToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function sessionExpiryIso(): string {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function mapUser(row: {
  id: string;
  email: string | null;
  displayName: string;
  passwordHash: string | null;
  isAdmin: boolean;
  createdAt: string;
}): DbUser {
  return row;
}

function rowToSessionUser(user: DbUser, provider: SessionUser["provider"]): SessionUser {
  return {
    user_id: user.id,
    tenant_id: user.id,
    login: user.email ?? user.displayName,
    display_name: user.displayName,
    email: user.email,
    provider,
    is_admin: user.isAdmin,
  };
}

export class AuthStore {
  private readonly db: DrizzleDb;
  private readonly schema: AuthSchemaBundle;

  constructor(db: AppDrizzleDb, schema: AuthSchemaBundle = sqliteSchema) {
    this.db = asSyncDb(db);
    this.schema = schema;
  }

  countUsers(): number {
    const rows = this.db.select({ n: sql<number>`count(*)` }).from(this.schema.users).all();
    return Number(rows[0]?.n ?? 0);
  }

  findUserByEmail(email: string): DbUser | null {
    const row = this.db
      .select()
      .from(this.schema.users)
      .where(eq(this.schema.users.email, email.toLowerCase()))
      .get();
    return row ? mapUser(row as DbUser) : null;
  }

  findUserById(id: string): DbUser | null {
    const row = this.db.select().from(this.schema.users).where(eq(this.schema.users.id, id)).get();
    return row ? mapUser(row as DbUser) : null;
  }

  findIdentity(provider: AuthIdentityProvider, providerUserId: string): DbUser | null {
    const identity = this.db
      .select()
      .from(this.schema.authIdentities)
      .where(
        and(
          eq(this.schema.authIdentities.provider, provider),
          eq(this.schema.authIdentities.providerUserId, providerUserId),
        ),
      )
      .get() as { userId: string } | undefined;
    if (!identity) return null;
    return this.findUserById(identity.userId);
  }

  createUser(input: {
    email?: string | null;
    displayName: string;
    passwordHash?: string | null;
    isAdmin?: boolean;
  }): DbUser {
    const id = randomUUID();
    const now = new Date().toISOString();
    const isFirst = this.countUsers() === 0;
    const user = this.db
      .insert(this.schema.users)
      .values({
        id,
        email: input.email?.toLowerCase() ?? null,
        displayName: input.displayName.trim() || "User",
        passwordHash: input.passwordHash ?? null,
        isAdmin: input.isAdmin ?? isFirst,
        createdAt: now,
      })
      .returning()
      .get() as DbUser;
    if (!user) throw new Error("Failed to create user");
    if (isFirst) this.reassignDefaultTenant(id);
    return mapUser(user);
  }

  linkIdentity(userId: string, provider: AuthIdentityProvider, providerUserId: string): void {
    const existing = this.db
      .select()
      .from(this.schema.authIdentities)
      .where(
        and(
          eq(this.schema.authIdentities.provider, provider),
          eq(this.schema.authIdentities.providerUserId, providerUserId),
        ),
      )
      .get();
    if (existing) return;
    this.db
      .insert(this.schema.authIdentities)
      .values({ userId, provider, providerUserId })
      .run();
  }

  upsertOAuthUser(input: {
    provider: AuthIdentityProvider;
    providerUserId: string;
    displayName: string;
    email?: string | null;
  }): DbUser {
    let user = this.findIdentity(input.provider, input.providerUserId);
    if (user) return user;
    if (input.email) {
      user = this.findUserByEmail(input.email);
      if (user) {
        this.linkIdentity(user.id, input.provider, input.providerUserId);
        return user;
      }
    }
    user = this.createUser({
      email: input.email,
      displayName: input.displayName,
    });
    this.linkIdentity(user.id, input.provider, input.providerUserId);
    return user;
  }

  createSession(userId: string): string {
    const raw = randomBytes(32).toString("hex");
    const id = hashSessionToken(raw);
    this.db
      .insert(this.schema.sessions)
      .values({ id, userId, expiresAt: sessionExpiryIso() })
      .run();
    return raw;
  }

  resolveSession(rawToken: string, provider: SessionUser["provider"] = "email"): SessionUser | null {
    const id = hashSessionToken(rawToken);
    const now = new Date().toISOString();
    const row = this.db
      .select()
      .from(this.schema.sessions)
      .where(and(eq(this.schema.sessions.id, id), gt(this.schema.sessions.expiresAt, now)))
      .get() as { userId: string } | undefined;
    if (!row) return null;
    const user = this.findUserById(row.userId);
    if (!user) return null;
    return rowToSessionUser(user, provider);
  }

  deleteSession(rawToken: string): void {
    const id = hashSessionToken(rawToken);
    this.db.delete(this.schema.sessions).where(eq(this.schema.sessions.id, id)).run();
  }

  deleteAllUserSessions(userId: string): void {
    this.db.delete(this.schema.sessions).where(eq(this.schema.sessions.userId, userId)).run();
  }

  updatePasswordHash(userId: string, passwordHash: string): void {
    this.db
      .update(this.schema.users)
      .set({ passwordHash })
      .where(eq(this.schema.users.id, userId))
      .run();
  }

  invalidatePasswordResetTokens(userId: string): void {
    this.db
      .delete(this.schema.passwordResetTokens)
      .where(eq(this.schema.passwordResetTokens.userId, userId))
      .run();
  }

  createPasswordResetToken(userId: string): string {
    const raw = randomBytes(32).toString("base64url");
    const id = hashSessionToken(raw);
    const now = new Date();
    this.db
      .insert(this.schema.passwordResetTokens)
      .values({
        id,
        userId,
        expiresAt: new Date(now.getTime() + RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString(),
        createdAt: now.toISOString(),
      })
      .run();
    return raw;
  }

  consumePasswordResetToken(rawToken: string): string | null {
    const id = hashSessionToken(rawToken);
    const now = new Date().toISOString();
    const row = this.db
      .select()
      .from(this.schema.passwordResetTokens)
      .where(and(eq(this.schema.passwordResetTokens.id, id), gt(this.schema.passwordResetTokens.expiresAt, now)))
      .get() as { userId: string } | undefined;
    if (!row) return null;
    this.db.delete(this.schema.passwordResetTokens).where(eq(this.schema.passwordResetTokens.id, id)).run();
    return row.userId;
  }

  reassignDefaultTenant(userId: string): void {
    const tables = [
      this.schema.projects,
      this.schema.buildProfiles,
      this.schema.profileLayers,
      this.schema.parts,
      this.schema.printProgress,
      this.schema.appSettings,
    ] as const;
    for (const table of tables) {
      this.db.update(table).set({ tenantId: userId }).where(eq(table.tenantId, "default")).run();
    }
  }

  createPlanShare(input: {
    fromUserId: string;
    planId: number;
    planName: string;
    bundleJson: string;
    recipientEmail?: string | null;
  }): { id: string; token: string } {
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    this.db
      .insert(this.schema.planShares)
      .values({
        id,
        token,
        fromUserId: input.fromUserId,
        planId: input.planId,
        planName: input.planName,
        recipientEmail: input.recipientEmail?.toLowerCase() ?? null,
        bundleJson: input.bundleJson,
        status: "pending",
        createdAt: new Date().toISOString(),
      })
      .run();
    return { id, token };
  }

  listIncomingShares(recipientEmail: string | null, userId: string): PlanShareRow[] {
    const rows = this.db
      .select()
      .from(this.schema.planShares)
      .where(eq(this.schema.planShares.status, "pending"))
      .all() as Array<{
      id: string;
      token: string;
      fromUserId: string;
      planId: number;
      planName: string;
      recipientEmail: string | null;
      status: string;
      createdAt: string;
    }>;
    return rows
      .filter((row) => {
        if (row.fromUserId === userId) return false;
        if (!row.recipientEmail) return true;
        if (!recipientEmail) return false;
        return row.recipientEmail === recipientEmail.toLowerCase();
      })
      .map((row) => {
        const from = this.findUserById(row.fromUserId);
        return {
          ...row,
          fromDisplayName: from?.displayName ?? "Unknown",
        };
      });
  }

  getShareByToken(token: string): PlanShareRow | null {
    const row = this.db
      .select()
      .from(this.schema.planShares)
      .where(eq(this.schema.planShares.token, token))
      .get() as {
      id: string;
      token: string;
      fromUserId: string;
      planId: number;
      planName: string;
      recipientEmail: string | null;
      bundleJson: string;
      status: string;
      createdAt: string;
    } | undefined;
    if (!row) return null;
    const from = this.findUserById(row.fromUserId);
    return {
      id: row.id,
      token: row.token,
      fromUserId: row.fromUserId,
      fromDisplayName: from?.displayName ?? "Unknown",
      planId: row.planId,
      planName: row.planName,
      recipientEmail: row.recipientEmail,
      status: row.status,
      createdAt: row.createdAt,
      bundleJson: row.bundleJson,
    };
  }

  getShareById(id: string): { id: string; fromUserId: string; status: string } | null {
    const row = this.db
      .select()
      .from(this.schema.planShares)
      .where(eq(this.schema.planShares.id, id))
      .get() as { id: string; fromUserId: string; status: string } | undefined;
    return row ?? null;
  }

  markShareAccepted(id: string): void {
    this.db
      .update(this.schema.planShares)
      .set({ status: "accepted" })
      .where(eq(this.schema.planShares.id, id))
      .run();
  }

  revokeShare(id: string, userId: string): boolean {
    const row = this.getShareById(id);
    if (!row || row.fromUserId !== userId || row.status !== "pending") return false;
    this.db
      .update(this.schema.planShares)
      .set({ status: "revoked" })
      .where(eq(this.schema.planShares.id, id))
      .run();
    return true;
  }
}

export function createAuthStore(db: AppDrizzleDb, driver: "sqlite" | "postgres"): AuthStore {
  return new AuthStore(db, driver === "postgres" ? pgSchema : sqliteSchema);
}

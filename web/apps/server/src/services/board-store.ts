import { desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDb } from "../db/client.js";
import { asSyncDb, type AppDrizzleDb } from "../db/sync-db-bridge.js";
import * as sqliteSchema from "../db/schema.js";
import * as pgSchema from "../db/schema-pg.js";

export type BoardSchemaBundle = typeof sqliteSchema | typeof pgSchema;

export type BoardPostSummary = {
  id: string;
  authorUserId: string;
  authorDisplayName: string;
  caption: string;
  title: string;
  coverUrl: string | null;
  createdAt: string;
};

export type BoardCommentRow = {
  id: string;
  postId: string;
  authorUserId: string;
  authorDisplayName: string;
  body: string;
  createdAt: string;
};

export type BoardPostRecord = BoardPostSummary & {
  snapshotJson: string;
  comments: BoardCommentRow[];
};

type PostRow = {
  id: string;
  authorUserId: string;
  caption: string;
  title: string;
  coverUrl: string | null;
  snapshotJson: string;
  createdAt: string;
  hiddenAt: string | null;
};

type CommentRow = {
  id: string;
  postId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
};

export class BoardStore {
  private db: DrizzleDb;
  private readonly schema: BoardSchemaBundle;

  constructor(db: AppDrizzleDb, schema: BoardSchemaBundle = sqliteSchema) {
    this.db = asSyncDb(db);
    this.schema = schema;
  }

  replaceDatabase(db: AppDrizzleDb): void {
    this.db = asSyncDb(db);
  }

  createPost(input: {
    authorUserId: string;
    caption: string;
    title: string;
    coverUrl: string | null;
    snapshotJson: string;
  }): BoardPostSummary {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .insert(this.schema.boardPosts)
      .values({
        id,
        authorUserId: input.authorUserId,
        caption: input.caption,
        title: input.title,
        coverUrl: input.coverUrl,
        snapshotJson: input.snapshotJson,
        createdAt: now,
        hiddenAt: null,
        hiddenByUserId: null,
      })
      .run();
    return {
      id,
      authorUserId: input.authorUserId,
      authorDisplayName: this.displayName(input.authorUserId),
      caption: input.caption,
      title: input.title,
      coverUrl: input.coverUrl,
      createdAt: now,
    };
  }

  listPosts(): BoardPostSummary[] {
    const rows = this.db
      .select()
      .from(this.schema.boardPosts)
      .where(isNull(this.schema.boardPosts.hiddenAt))
      .orderBy(desc(this.schema.boardPosts.createdAt))
      .all() as PostRow[];
    return rows.map((row) => this.toSummary(row));
  }

  getPost(id: string): BoardPostRecord | null {
    const row = this.db
      .select()
      .from(this.schema.boardPosts)
      .where(eq(this.schema.boardPosts.id, id))
      .get() as PostRow | undefined;
    if (!row || row.hiddenAt) return null;
    return {
      ...this.toSummary(row),
      snapshotJson: row.snapshotJson,
      comments: this.listComments(id),
    };
  }

  hidePost(id: string, adminUserId: string): boolean {
    const row = this.db
      .select()
      .from(this.schema.boardPosts)
      .where(eq(this.schema.boardPosts.id, id))
      .get() as PostRow | undefined;
    if (!row || row.hiddenAt) return false;
    this.db
      .update(this.schema.boardPosts)
      .set({
        hiddenAt: new Date().toISOString(),
        hiddenByUserId: adminUserId,
      })
      .where(eq(this.schema.boardPosts.id, id))
      .run();
    return true;
  }

  addComment(input: { postId: string; authorUserId: string; body: string }): BoardCommentRow | null {
    if (!this.getPost(input.postId)) return null;
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .insert(this.schema.boardComments)
      .values({
        id,
        postId: input.postId,
        authorUserId: input.authorUserId,
        body: input.body,
        createdAt: now,
      })
      .run();
    return {
      id,
      postId: input.postId,
      authorUserId: input.authorUserId,
      authorDisplayName: this.displayName(input.authorUserId),
      body: input.body,
      createdAt: now,
    };
  }

  deleteComment(id: string, actor: { userId: string; isAdmin: boolean }): boolean {
    const row = this.db
      .select()
      .from(this.schema.boardComments)
      .where(eq(this.schema.boardComments.id, id))
      .get() as CommentRow | undefined;
    if (!row) return false;
    if (row.authorUserId !== actor.userId && !actor.isAdmin) return false;
    this.db.delete(this.schema.boardComments).where(eq(this.schema.boardComments.id, id)).run();
    return true;
  }

  private listComments(postId: string): BoardCommentRow[] {
    const rows = this.db
      .select()
      .from(this.schema.boardComments)
      .where(eq(this.schema.boardComments.postId, postId))
      .all() as CommentRow[];
    return rows
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((row) => ({
      id: row.id,
      postId: row.postId,
      authorUserId: row.authorUserId,
      authorDisplayName: this.displayName(row.authorUserId),
      body: row.body,
      createdAt: row.createdAt,
    }));
  }

  private toSummary(row: PostRow): BoardPostSummary {
    return {
      id: row.id,
      authorUserId: row.authorUserId,
      authorDisplayName: this.displayName(row.authorUserId),
      caption: row.caption,
      title: row.title,
      coverUrl: row.coverUrl,
      createdAt: row.createdAt,
    };
  }

  private displayName(userId: string): string {
    const row = this.db
      .select()
      .from(this.schema.users)
      .where(eq(this.schema.users.id, userId))
      .get() as { displayName: string } | undefined;
    return row?.displayName ?? "User";
  }
}

export function createBoardStore(
  db: AppDrizzleDb,
  driver: "sqlite" | "postgres",
): BoardStore {
  return new BoardStore(db, driver === "postgres" ? pgSchema : sqliteSchema);
}

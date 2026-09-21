import type { FastifyInstance } from "fastify";
import type { AppRepository } from "../db/repository.js";
import {
  coverUrlFromSnapshot,
  freezeBuildSnapshot,
  normalizeBoardCaption,
  normalizeBoardComment,
} from "../lib/board-model.js";
import { exportBuildReferenceShare } from "../services/reference-sharing.js";
import type { BoardStore } from "../services/board-store.js";
import { isRecord } from "./job-route-inputs.js";

const writeLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

function requireSession(request: { sessionUser?: { user_id: string } | null }) {
  return request.sessionUser ?? null;
}

function summarize(post: {
  id: string;
  authorDisplayName: string;
  caption: string;
  title: string;
  coverUrl: string | null;
  createdAt: string;
}) {
  return {
    id: post.id,
    author_display_name: post.authorDisplayName,
    caption: post.caption,
    title: post.title,
    cover_url: post.coverUrl,
    created_at: post.createdAt,
  };
}

export function registerBoardRoutes(
  app: FastifyInstance,
  deps: { repo: AppRepository; boardStore: BoardStore },
): void {
  const { repo, boardStore } = deps;

  app.get("/board/posts", async (request, reply) => {
    if (!requireSession(request)) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    return { posts: boardStore.listPosts().map(summarize) };
  });

  app.get("/board/posts/:id", async (request, reply) => {
    if (!requireSession(request)) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    const id = (request.params as { id: string }).id;
    const post = boardStore.getPost(id);
    if (!post) return reply.status(404).send({ detail: "Post not found" });
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(post.snapshotJson);
    } catch {
      return reply.status(500).send({ detail: "Stored snapshot is unreadable" });
    }
    return {
      post: {
        ...summarize(post),
        author_user_id: post.authorUserId,
        snapshot,
      },
      comments: post.comments.map((comment) => ({
        id: comment.id,
        author_user_id: comment.authorUserId,
        author_display_name: comment.authorDisplayName,
        body: comment.body,
        created_at: comment.createdAt,
      })),
    };
  });

  app.post("/board/posts", writeLimit, async (request, reply) => {
    const session = requireSession(request);
    if (!session) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    if (!isRecord(request.body)) {
      return reply.status(400).send({ detail: "Request body must be an object" });
    }
    const planId = Number(request.body.plan_id);
    if (!Number.isSafeInteger(planId) || planId <= 0) {
      return reply.status(400).send({ detail: "Invalid Build id" });
    }
    const caption = normalizeBoardCaption(request.body.caption);
    if (!caption) {
      return reply.status(400).send({ detail: "Caption must be between 1 and 500 characters" });
    }
    if (!repo.getOwnedProfileIdentity(planId)) {
      return reply.status(404).send({ detail: "Build not found" });
    }
    let exported;
    try {
      exported = exportBuildReferenceShare(repo, planId);
    } catch {
      return reply.status(409).send({
        detail:
          "This Build cannot be represented safely as a reference manifest. Check its Source links and relative file paths.",
      });
    }
    const frozen = freezeBuildSnapshot(exported.manifest);
    if (!frozen) {
      return reply.status(400).send({ detail: "Only a references-only Build snapshot can be posted" });
    }
    const post = boardStore.createPost({
      authorUserId: session.user_id,
      caption,
      title: frozen.title,
      coverUrl: coverUrlFromSnapshot(frozen.parsed),
      snapshotJson: frozen.json,
    });
    return { post: summarize(post) };
  });

  app.post("/board/posts/:id/hide", writeLimit, async (request, reply) => {
    const session = request.sessionUser;
    if (!session) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    if (!session.is_admin) {
      return reply.status(403).send({ detail: "Administrator access required" });
    }
    const id = (request.params as { id: string }).id;
    const hidden = boardStore.hidePost(id, session.user_id);
    if (!hidden) return reply.status(404).send({ detail: "Post not found" });
    return { ok: true };
  });

  app.post("/board/posts/:id/comments", writeLimit, async (request, reply) => {
    const session = requireSession(request);
    if (!session) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    const id = (request.params as { id: string }).id;
    if (!isRecord(request.body)) {
      return reply.status(400).send({ detail: "Request body must be an object" });
    }
    const body = normalizeBoardComment(request.body.body);
    if (!body) {
      return reply.status(400).send({ detail: "Comment must be between 1 and 2000 characters" });
    }
    const comment = boardStore.addComment({
      postId: id,
      authorUserId: session.user_id,
      body,
    });
    if (!comment) return reply.status(404).send({ detail: "Post not found" });
    return {
      comment: {
        id: comment.id,
        author_user_id: comment.authorUserId,
        author_display_name: comment.authorDisplayName,
        body: comment.body,
        created_at: comment.createdAt,
      },
    };
  });

  app.delete("/board/comments/:id", writeLimit, async (request, reply) => {
    const session = request.sessionUser;
    if (!session) {
      return reply.status(401).send({ detail: "Authentication required" });
    }
    const id = (request.params as { id: string }).id;
    const deleted = boardStore.deleteComment(id, {
      userId: session.user_id,
      isAdmin: session.is_admin,
    });
    if (!deleted) return reply.status(404).send({ detail: "Comment not found" });
    return { ok: true };
  });
}

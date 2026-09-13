import type { ReferenceShare } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export type BoardPostSummary = {
  id: string;
  author_display_name: string;
  caption: string;
  title: string;
  cover_url: string | null;
  created_at: string;
};

export type BoardComment = {
  id: string;
  author_user_id: string;
  author_display_name: string;
  body: string;
  created_at: string;
};

export type BoardPostDetail = BoardPostSummary & {
  author_user_id: string;
  snapshot: ReferenceShare;
};

export async function fetchBoardPosts(): Promise<{ posts: BoardPostSummary[] }> {
  return engineFetch<{ posts: BoardPostSummary[] }>("/board/posts");
}

export async function fetchBoardPost(
  id: string,
): Promise<{ post: BoardPostDetail; comments: BoardComment[] }> {
  return engineFetch<{ post: BoardPostDetail; comments: BoardComment[] }>(`/board/posts/${id}`);
}

export async function createBoardPost(input: {
  plan_id: number;
  caption: string;
}): Promise<{ post: BoardPostSummary }> {
  return engineFetch<{ post: BoardPostSummary }>("/board/posts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function hideBoardPost(id: string): Promise<{ ok: true }> {
  return engineFetch<{ ok: true }>(`/board/posts/${id}/hide`, { method: "POST" });
}

export async function createBoardComment(
  postId: string,
  body: string,
): Promise<{ comment: BoardComment }> {
  return engineFetch<{ comment: BoardComment }>(`/board/posts/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function deleteBoardComment(id: string): Promise<{ ok: true }> {
  return engineFetch<{ ok: true }>(`/board/comments/${id}`, { method: "DELETE" });
}

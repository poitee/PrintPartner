import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Newspaper } from "lucide-react";
import type { ReferenceShare } from "@print-partner/contracts";
import {
  createBoardComment,
  deleteBoardComment,
  fetchBoardPost,
  fetchBoardPosts,
  hideBoardPost,
  type BoardComment,
  type BoardPostDetail,
  type BoardPostSummary,
} from "../api/endpoints/board";
import ReferenceShareImport from "../components/share/ReferenceShareImport";
import PageHeader from "../components/layout/PageHeader";
import PageShell from "../components/layout/PageShell";
import EmptyState from "../components/layout/EmptyState";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { useAuth } from "../context/AuthContext";
import { useDateFormat } from "../context/DateFormatContext";
import { boardRoute } from "../lib/routes";

function sourceLabel(source: ReferenceShare["sources"][number]): string {
  if (source.location.kind === "publisher") return `${source.name} · ${source.location.url}`;
  return `${source.name} · files are not on a publisher page`;
}

function RecipePreview({ snapshot }: { snapshot: ReferenceShare }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{snapshot.title}</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {snapshot.sources.map((source) => (
          <li key={source.key}>{sourceLabel(source)}</li>
        ))}
      </ul>
      {snapshot.kind === "build" ? (
        <p className="text-muted-foreground">{snapshot.parts.length} parts in the frozen recipe.</p>
      ) : null}
    </div>
  );
}

function Cover({ url, title }: { url: string | null; title: string }) {
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      className="h-40 w-full rounded-md object-cover"
      title={title}
    />
  );
}

function Feed() {
  const { formatDate } = useDateFormat();
  const [posts, setPosts] = useState<BoardPostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchBoardPosts()
      .then((result) => {
        if (active) setPosts(result.posts);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "The board could not be loaded");
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!posts) return <p role="status" className="text-sm text-muted-foreground">Loading…</p>;
  if (posts.length === 0) {
    return (
      <EmptyState
        icon={Newspaper}
        title="No posts yet"
        description="Share a Build from Plan. The post stores a frozen references-only recipe, not model files."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {posts.map((post) => (
        <li key={post.id}>
          <Link
            to={boardRoute(post.id)}
            className="block rounded-lg border border-border p-4 transition-colors hover:bg-accent/70"
          >
            <Cover url={post.cover_url} title={post.title} />
            <p className="mt-3 font-medium">{post.caption}</p>
            <p className="mt-1 text-sm text-muted-foreground">{post.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {post.author_display_name} · {formatDate(post.created_at)}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function PostDetail({ postId }: { postId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { formatDate } = useDateFormat();
  const [post, setPost] = useState<BoardPostDetail | null>(null);
  const [comments, setComments] = useState<BoardComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchBoardPost(postId)
      .then((result) => {
        if (!active) return;
        setPost(result.post);
        setComments(result.comments);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "Post not found");
      });
    return () => {
      active = false;
    };
  }, [postId]);

  const onComment = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void createBoardComment(postId, body)
      .then((result) => {
        setComments((current) => [...current, result.comment]);
        setBody("");
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "Comment failed");
      })
      .finally(() => setBusy(false));
  };

  const onDeleteComment = (id: string) => {
    setError(null);
    void deleteBoardComment(id)
      .then(() => setComments((current) => current.filter((comment) => comment.id !== id)))
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "Could not delete the comment");
      });
  };

  const onHide = () => {
    void hideBoardPost(postId)
      .then(() => navigate(boardRoute()))
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "Could not hide the post");
      });
  };

  if (error && !post) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!post) return <p role="status" className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Card>
        <CardHeader accent>
          <CardTitle className="text-base">{post.caption}</CardTitle>
          <CardDescription>
            {post.author_display_name} · {formatDate(post.created_at)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Cover url={post.cover_url} title={post.title} />
          <RecipePreview snapshot={post.snapshot} />
          {post.snapshot.kind === "build" ? (
            <ReferenceShareImport manifest={post.snapshot} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This collection lists sources. It does not create a Build.
            </p>
          )}
          {user?.is_admin ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={onHide}>
                Hide post
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          ) : (
            <ul className="space-y-3">
              {comments.map((comment) => (
                <li key={comment.id} className="rounded-md border border-border p-3">
                  <p className="text-sm">{comment.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {comment.author_display_name} · {formatDate(comment.created_at)}
                  </p>
                  {user && (user.is_admin || user.user_id === comment.author_user_id) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => onDeleteComment(comment.id)}
                    >
                      Delete
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <form className="space-y-2" onSubmit={onComment}>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Comment</span>
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={2000}
                required
              />
            </label>
            <Button type="submit" disabled={busy || body.trim().length === 0}>
              {busy ? "Posting…" : "Post comment"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BoardPage() {
  const { postId } = useParams();
  return (
    <PageShell width="list">
      <PageHeader
        icon={Newspaper}
        title="Board"
        description="Invitees post a frozen references-only Build recipe. Comments stay flat. Model files stay with the publishers."
        actions={
          postId ? (
            <Button variant="ghost" asChild>
              <Link to={boardRoute()}>All posts</Link>
            </Button>
          ) : null
        }
      />
      {postId ? <PostDetail postId={postId} /> : <Feed />}
    </PageShell>
  );
}

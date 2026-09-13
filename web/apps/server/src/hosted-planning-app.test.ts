import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_PLANNING_CAPABILITY, INVITE_BOARD_CAPABILITY } from "@print-partner/contracts";
import { createSaasPorts } from "./adapters/saas/index.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HOSTED_FEATURE_DISABLED_DETAIL, HOSTED_LAN_DISABLED_DETAIL } from "./lib/hosted-planning-deny.js";
import { assertSafeOutboundUrl, setPrivateOutboundDenied } from "./lib/outbound-url.js";

const dirs: string[] = [];

afterEach(() => {
  setPrivateOutboundDenied(false);
  delete process.env.DEPLOY_MODE;
  delete process.env.SAAS_DATA_DIR;
  delete process.env.SAAS_ALLOW_ANONYMOUS;
  delete process.env.DATABASE_URL;
  delete process.env.MULTI_USER;
  delete process.env.REGISTRATION_OPEN;
  delete process.env.PRINT_PARTNER_DATA_DIR;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function hostedApp(options: { registrationOpen?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pp-hosted-"));
  dirs.push(dir);
  process.env.DEPLOY_MODE = "saas";
  process.env.SAAS_DATA_DIR = dir;
  process.env.MULTI_USER = "1";
  delete process.env.DATABASE_URL;
  delete process.env.SAAS_ALLOW_ANONYMOUS;
  if (options.registrationOpen === false) process.env.REGISTRATION_OPEN = "0";
  else delete process.env.REGISTRATION_OPEN;

  const config = { ...loadConfig(), dataDir: dir, deployMode: "saas" as const };
  const ports = createSaasPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}

describe("hosted planning host", () => {
  it("advertises hosted_planning and denies LAN adapter writes", async () => {
    const { app, ports } = await hostedApp();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      const body = health.json() as { capabilities?: string[] };
      expect(body.capabilities).toContain(HOSTED_PLANNING_CAPABILITY);
      expect(body.capabilities).toContain(INVITE_BOARD_CAPABILITY);
      expect(body.capabilities).not.toContain("mcp_http");
      expect(body.capabilities).not.toContain("backups");
      expect(body.capabilities).not.toContain("plan_sharing");
      expect(body.capabilities).not.toContain("github_oauth");
      expect(body.capabilities).not.toContain("discord_oauth");

      const denied = await app.inject({
        method: "POST",
        url: "/api/v1/integrations",
        payload: {
          type: "moonraker",
          name: "LAN",
          config: { base_url: "http://192.168.1.40:7125", enabled: true },
        },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ detail: HOSTED_LAN_DISABLED_DETAIL });

      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/v1/integrations/host-1",
      });
      expect(deleted.statusCode).toBe(403);
      expect(deleted.json()).toMatchObject({ detail: HOSTED_LAN_DISABLED_DETAIL });

      const registered = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "planner@example.com", password: "correct-horse-battery" },
      });
      expect(registered.statusCode).toBe(200);
      const user = registered.json() as { user?: { user_id?: string } };
      expect(user.user?.user_id).toBeTruthy();
      expect(user.user?.user_id).not.toBe("default");
      const cookie = String(registered.headers["set-cookie"]).split(";")[0]!;
      const access = await app.inject({
        method: "GET",
        url: "/settings/external-access",
        headers: { cookie },
      });
      expect(access.statusCode).toBe(200);
      expect(access.json()).toMatchObject({ mode: "off" });

      const localSource = await app.inject({
        method: "POST",
        url: "/api/v1/sources",
        headers: { cookie },
        payload: { name: "LAN folder", source_kind: "local", local_path: "/tmp/models" },
      });
      expect(localSource.statusCode).toBe(400);
      expect(localSource.json()).toMatchObject({
        detail: "The hosted planning site accepts GitHub and zip sources only.",
      });

      const mcp = await app.inject({
        method: "POST",
        url: "/api/v1/mcp",
        headers: { cookie },
      });
      expect(mcp.statusCode).toBe(403);

      await expect(
        assertSafeOutboundUrl("http://192.168.1.50:7912/api/v1/info", { allowPrivate: true }),
      ).rejects.toThrow(/private or internal/);
    } finally {
      await app.close();
      await ports.db.close();
    }
  });

  it("closes registration when REGISTRATION_OPEN=0", async () => {
    const { app, ports } = await hostedApp({ registrationOpen: false });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({ registration_open: false });

      const register = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "invitee@example.com",
          password: "correct-horse-battery",
        },
      });
      expect(register.statusCode).toBe(403);
      expect(register.json()).toMatchObject({ detail: "Registration is closed" });
    } finally {
      await app.close();
      await ports.db.close();
    }
  });

  it("posts a frozen board recipe, comments, and hides Kit copies", async () => {
    const { app, ports } = await hostedApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "ada@example.com",
          password: "correct-horse-battery",
          display_name: "Ada",
        },
      });
      expect(first.statusCode).toBe(200);
      const ada = first.json() as { user: { user_id: string; is_admin: boolean } };
      expect(ada.user.is_admin).toBe(true);
      const adaCookie = String(first.headers["set-cookie"]).split(";")[0]!;

      const second = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "bev@example.com",
          password: "correct-horse-battery",
          display_name: "Bev",
        },
      });
      expect(second.statusCode).toBe(200);
      const bev = second.json() as { user: { user_id: string; is_admin: boolean } };
      expect(bev.user.is_admin).toBe(false);
      const bevCookie = String(second.headers["set-cookie"]).split(";")[0]!;

      const repo = ports.getRepository(ada.user.user_id);
      const source = repo.createSource({
        name: "Voron",
        url: "https://github.com/VoronDesign/Voron-2",
        source_kind: "github",
      });
      const profile = repo.createProfile("Board Build", source.id);

      const anonymous = await app.inject({ method: "GET", url: "/board/posts" });
      expect(anonymous.statusCode).toBe(401);

      const kit = await app.inject({
        method: "POST",
        url: `/api/v1/plans/${profile.id}/shares`,
        headers: { cookie: adaCookie },
        payload: { recipient_email: null },
      });
      expect(kit.statusCode).toBe(403);
      expect(kit.json()).toMatchObject({ detail: HOSTED_FEATURE_DISABLED_DETAIL });

      const emptyPost = await app.inject({
        method: "POST",
        url: "/board/posts",
        headers: { cookie: adaCookie },
      });
      expect(emptyPost.statusCode).toBe(400);
      expect(emptyPost.json()).toMatchObject({ detail: "Request body must be an object" });

      const posted = await app.inject({
        method: "POST",
        url: "/board/posts",
        headers: { cookie: adaCookie },
        payload: { plan_id: profile.id, caption: "  First recipe  " },
      });
      expect(posted.statusCode).toBe(200);
      const created = posted.json() as {
        post: { id: string; caption: string; title: string; cover_url: string | null };
      };
      expect(created.post.caption).toBe("First recipe");
      expect(created.post.title).toBe("Board Build");
      expect(created.post.cover_url).toBe(
        "https://opengraph.githubassets.com/1/VoronDesign/Voron-2",
      );

      repo.renameProfile(profile.id, "Edited later");
      const feed = await app.inject({
        method: "GET",
        url: "/board/posts",
        headers: { cookie: bevCookie },
      });
      expect(feed.statusCode).toBe(200);
      const listed = feed.json() as { posts: Array<{ id: string; title: string; snapshot?: unknown }> };
      expect(listed.posts).toHaveLength(1);
      expect(listed.posts[0]?.id).toBe(created.post.id);
      expect(listed.posts[0]?.title).toBe("Board Build");
      expect(listed.posts[0]?.snapshot).toBeUndefined();

      const detail = await app.inject({
        method: "GET",
        url: `/board/posts/${created.post.id}`,
        headers: { cookie: bevCookie },
      });
      expect(detail.statusCode).toBe(200);
      const body = detail.json() as {
        post: { title: string; snapshot: { kind: string; title: string } };
        comments: unknown[];
      };
      expect(body.post.title).toBe("Board Build");
      expect(body.post.snapshot).toMatchObject({ kind: "build", title: "Board Build" });
      expect(body.comments).toEqual([]);

      const emptyComment = await app.inject({
        method: "POST",
        url: `/board/posts/${created.post.id}/comments`,
        headers: { cookie: bevCookie },
      });
      expect(emptyComment.statusCode).toBe(400);
      expect(emptyComment.json()).toMatchObject({ detail: "Request body must be an object" });

      const comment = await app.inject({
        method: "POST",
        url: `/board/posts/${created.post.id}/comments`,
        headers: { cookie: bevCookie },
        payload: { body: "I will sync this in my Library" },
      });
      expect(comment.statusCode).toBe(200);
      const written = comment.json() as { comment: { id: string; author_display_name: string } };
      expect(written.comment.author_display_name).toBe("Bev");

      const forbiddenHide = await app.inject({
        method: "POST",
        url: `/board/posts/${created.post.id}/hide`,
        headers: { cookie: bevCookie },
      });
      expect(forbiddenHide.statusCode).toBe(403);

      const deletedOwn = await app.inject({
        method: "DELETE",
        url: `/board/comments/${written.comment.id}`,
        headers: { cookie: bevCookie },
      });
      expect(deletedOwn.statusCode).toBe(200);

      const leftover = await app.inject({
        method: "POST",
        url: `/board/posts/${created.post.id}/comments`,
        headers: { cookie: adaCookie },
        payload: { body: "still here" },
      });
      const leftoverId = (leftover.json() as { comment: { id: string } }).comment.id;
      const adminDelete = await app.inject({
        method: "DELETE",
        url: `/board/comments/${leftoverId}`,
        headers: { cookie: adaCookie },
      });
      expect(adminDelete.statusCode).toBe(200);

      const hidden = await app.inject({
        method: "POST",
        url: `/board/posts/${created.post.id}/hide`,
        headers: { cookie: adaCookie },
      });
      expect(hidden.statusCode).toBe(200);
      const missing = await app.inject({
        method: "GET",
        url: `/board/posts/${created.post.id}`,
        headers: { cookie: bevCookie },
      });
      expect(missing.statusCode).toBe(404);
      const emptyFeed = await app.inject({
        method: "GET",
        url: "/board/posts",
        headers: { cookie: bevCookie },
      });
      expect(emptyFeed.json()).toMatchObject({ posts: [] });
    } finally {
      await app.close();
      await ports.db.close();
    }
  });
});

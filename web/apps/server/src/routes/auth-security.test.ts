import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig, type ServerConfig } from "../config.js";

const originalNodeEnv = process.env.NODE_ENV;

async function makeProductionApp(dir: string, overrides: Partial<ServerConfig> = {}) {
  const config = {
    ...loadConfig(),
    dataDir: dir,
    multiUser: true,
    authRequired: true,
    sessionSecret: "test-session-secret",
    sessionCookieSecure: true,
    ...overrides,
  };
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}

describe("production authentication routes", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("does not register the development login route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-production-dev-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { login: "attacker" },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks production session cookies Secure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-production-cookie-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "admin@example.com",
          password: "correct-horse-battery",
          display_name: "Admin",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toContain("Secure");
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates other sessions when the password changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-change-password-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const registration = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "sessions@example.com",
          password: "correct-horse-battery",
          display_name: "Sessions",
        },
      });
      expect(registration.statusCode).toBe(200);
      const firstCookie = String(registration.headers["set-cookie"]).split(";", 1)[0];

      const secondLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "sessions@example.com",
          password: "correct-horse-battery",
        },
      });
      expect(secondLogin.statusCode).toBe(200);
      const secondCookie = String(secondLogin.headers["set-cookie"]).split(";", 1)[0];

      const changed = await app.inject({
        method: "POST",
        url: "/auth/change-password",
        headers: { cookie: firstCookie },
        payload: {
          current_password: "correct-horse-battery",
          new_password: "correct-horse-battery-2",
        },
      });
      expect(changed.statusCode).toBe(200);
      const refreshedCookie = String(changed.headers["set-cookie"]).split(";", 1)[0];
      expect(refreshedCookie).toMatch(/^pp_session=/);
      expect(refreshedCookie).not.toBe(firstCookie);

      const otherSession = await app.inject({
        method: "GET",
        url: "/health",
        headers: { cookie: secondCookie },
      });
      expect(otherSession.json()).toMatchObject({ authenticated: false });

      const currentSession = await app.inject({
        method: "GET",
        url: "/health",
        headers: { cookie: refreshedCookie },
      });
      expect(currentSession.json()).toMatchObject({ authenticated: true });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports whether the health request has an authenticated session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-production-health-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const anonymous = await app.inject({ method: "GET", url: "/health" });
      expect(anonymous.json()).toMatchObject({ multi_user: true, authenticated: false });

      const registration = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "health@example.com",
          password: "correct-horse-battery",
          display_name: "Health Session",
        },
      });
      const cookie = String(registration.headers["set-cookie"]).split(";", 1)[0];
      const authenticated = await app.inject({
        method: "GET",
        url: "/health",
        headers: { cookie },
      });

      expect(authenticated.json()).toMatchObject({ multi_user: true, authenticated: true });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks production OAuth state cookies Secure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-production-oauth-cookie-"));
    const config = {
      ...loadConfig(),
      dataDir: dir,
      multiUser: true,
      authRequired: true,
      sessionSecret: "test-session-secret",
      sessionCookieSecure: true,
      githubClientId: "github-client",
      githubClientSecret: "github-secret",
      githubCallbackUrl: "https://app.example.com/auth/callback",
      githubOAuthConfigured: true,
      discordClientId: "discord-client",
      discordClientSecret: "discord-secret",
      discordCallbackUrl: "https://app.example.com/auth/discord/callback",
      discordOAuthConfigured: true,
    };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      for (const url of ["/auth/github", "/auth/discord"]) {
        const response = await app.inject({ method: "GET", url });

        expect.soft(response.statusCode, url).toBe(302);
        expect.soft(response.headers["set-cookie"], url).toContain("Secure");
      }
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores forwarding headers when proxy trust is disabled for password reset URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-reset-origin-"));
    const { app, ports } = await makeProductionApp(dir, {
      trustProxy: false,
      passwordResetDevExpose: true,
    });

    try {
      const registration = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "reset@example.com",
          password: "correct-horse-battery",
          display_name: "Reset",
        },
      });
      expect(registration.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: "/auth/forgot-password",
        headers: {
          host: "print.example.com",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        },
        payload: { email: "reset@example.com" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        dev_reset_url: expect.stringMatching(
          /^http:\/\/print\.example\.com\/reset-password\?token=/,
        ),
      });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not link a GitHub identity through an unverified profile email", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-github-email-"));
    const { app, ports } = await makeProductionApp(dir, {
      githubClientId: "github-client",
      githubClientSecret: "github-secret",
      githubCallbackUrl: "https://print.example.com/auth/callback",
      githubOAuthConfigured: true,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const registration = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "victim@example.com",
          password: "correct-horse-battery",
          display_name: "Victim",
        },
      });
      expect(registration.statusCode).toBe(200);
      const registeredUserId = registration.json().user.user_id;

      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "github-token" }), {
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 42,
              login: "octocat",
              name: "Octo Cat",
              email: "victim@example.com",
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { email: "victim@example.com", primary: true, verified: false },
            ]),
            { headers: { "Content-Type": "application/json" } },
          ),
        );

      const oauthStart = await app.inject({ method: "GET", url: "/auth/github" });
      const stateCookie = oauthStart.cookies.find((cookie) => cookie.name === "oauth_state");
      expect(stateCookie).toBeDefined();

      const callback = await app.inject({
        method: "GET",
        url: `/auth/callback?code=github-code&state=${stateCookie?.value ?? ""}`,
        cookies: { oauth_state: stateCookie?.value ?? "" },
      });
      expect(callback.statusCode).toBe(302);
      const sessionCookie = callback.cookies.find((cookie) => cookie.name === "pp_session");
      expect(sessionCookie).toBeDefined();

      const currentUser = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { pp_session: sessionCookie?.value ?? "" },
      });
      expect(currentUser.statusCode).toBe(200);
      expect(currentUser.json().user).toMatchObject({ email: null });
      expect(currentUser.json().user.user_id).not.toBe(registeredUserId);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels a rejected GitHub email response before continuing without email", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-github-email-failure-"));
    const { app, ports } = await makeProductionApp(dir, {
      githubClientId: "github-client",
      githubClientSecret: "github-secret",
      githubCallbackUrl: "https://print.example.com/auth/callback",
      githubOAuthConfigured: true,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const cancelEmailBody = vi.fn(async () => {
      throw new Error("connection already closed");
    });
    const emailResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("GitHub email lookup failed"));
        },
        cancel: cancelEmailBody,
      }),
      { status: 502 },
    );

    try {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "github-token" }), {
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: 42, login: "octocat", name: "Octo Cat" }),
            { headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(emailResponse);

      const oauthStart = await app.inject({ method: "GET", url: "/auth/github" });
      const stateCookie = oauthStart.cookies.find((cookie) => cookie.name === "oauth_state");
      const callback = await app.inject({
        method: "GET",
        url: `/auth/callback?code=github-code&state=${stateCookie?.value ?? ""}`,
        cookies: { oauth_state: stateCookie?.value ?? "" },
      });

      expect(callback.statusCode).toBe(302);
      expect(cancelEmailBody).toHaveBeenCalledOnce();
      const sessionCookie = callback.cookies.find((cookie) => cookie.name === "pp_session");
      const currentUser = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { pp_session: sessionCookie?.value ?? "" },
      });
      expect(currentUser.json().user).toMatchObject({ email: null });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues a linked GitHub login when verified-email enrichment is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-github-linked-email-failure-"));
    const { app, ports } = await makeProductionApp(dir, {
      githubClientId: "github-client",
      githubClientSecret: "github-secret",
      githubCallbackUrl: "https://print.example.com/auth/callback",
      githubOAuthConfigured: true,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    try {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "github-token" }), {
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 42,
              login: "octocat",
              name: "Octo Cat",
              email: "unverified@example.com",
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { email: "unverified@example.com", primary: true, verified: false },
              { email: "verified@example.com", primary: false, verified: true },
            ]),
            { headers: { "Content-Type": "application/json" } },
          ),
        );

      const firstStart = await app.inject({ method: "GET", url: "/auth/github" });
      const firstState = firstStart.cookies.find((cookie) => cookie.name === "oauth_state")?.value ?? "";
      const firstCallback = await app.inject({
        method: "GET",
        url: `/auth/callback?code=first-code&state=${firstState}`,
        cookies: { oauth_state: firstState },
      });
      expect(firstCallback.statusCode).toBe(302);
      const firstSession = firstCallback.cookies.find((cookie) => cookie.name === "pp_session")?.value ?? "";
      const firstUser = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { pp_session: firstSession },
      });
      expect(firstUser.json().user).toMatchObject({ email: "verified@example.com" });
      const linkedUserId = firstUser.json().user.user_id;

      fetchMock.mockClear();
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ access_token: "github-token" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ id: 42, login: "octocat", name: "Octo Cat" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://api.github.com/user/emails") {
          throw new TypeError("email endpoint unavailable");
        }
        throw new Error(`Unexpected OAuth request: ${url}`);
      });

      const start = await app.inject({ method: "GET", url: "/auth/github" });
      const state = start.cookies.find((cookie) => cookie.name === "oauth_state")?.value ?? "";
      const callback = await app.inject({
        method: "GET",
        url: `/auth/callback?code=linked-code&state=${state}`,
        cookies: { oauth_state: state },
      });

      expect(callback.statusCode).toBe(302);
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        "https://github.com/login/oauth/access_token",
        "https://api.github.com/user",
      ]);
      const session = callback.cookies.find((cookie) => cookie.name === "pp_session")?.value ?? "";
      const currentUser = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { pp_session: session },
      });
      expect(currentUser.json().user).toMatchObject({
        user_id: linkedUserId,
        email: "verified@example.com",
      });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not link a Discord identity through an unverified email", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-discord-email-"));
    const { app, ports } = await makeProductionApp(dir, {
      discordClientId: "discord-client",
      discordClientSecret: "discord-secret",
      discordCallbackUrl: "https://print.example.com/auth/discord/callback",
      discordOAuthConfigured: true,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const registration = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "victim@example.com",
          password: "correct-horse-battery",
          display_name: "Victim",
        },
      });
      expect(registration.statusCode).toBe(200);
      const registeredUserId = registration.json().user.user_id;

      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "discord-token" }), {
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "123",
              username: "printer",
              global_name: "Print Friend",
              email: "victim@example.com",
              verified: false,
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );

      const oauthStart = await app.inject({ method: "GET", url: "/auth/discord" });
      const stateCookie = oauthStart.cookies.find((cookie) => cookie.name === "oauth_state");
      expect(stateCookie).toBeDefined();

      const callback = await app.inject({
        method: "GET",
        url: `/auth/discord/callback?code=discord-code&state=${stateCookie?.value ?? ""}`,
        cookies: { oauth_state: stateCookie?.value ?? "" },
      });
      expect(callback.statusCode).toBe(302);
      const sessionCookie = callback.cookies.find((cookie) => cookie.name === "pp_session");
      expect(sessionCookie).toBeDefined();

      const currentUser = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { pp_session: sessionCookie?.value ?? "" },
      });
      expect(currentUser.statusCode).toBe(200);
      expect(currentUser.json().user).toMatchObject({ email: null });
      expect(currentUser.json().user.user_id).not.toBe(registeredUserId);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed OAuth provider identities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-provider-shape-"));
    const { app, ports } = await makeProductionApp(dir, {
      githubClientId: "github-client",
      githubClientSecret: "github-secret",
      githubCallbackUrl: "https://print.example.com/auth/callback",
      githubOAuthConfigured: true,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    try {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "github-token" }), {
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ login: "identity-without-id" }), {
            headers: { "Content-Type": "application/json" },
          }),
        );

      const oauthStart = await app.inject({ method: "GET", url: "/auth/github" });
      const stateCookie = oauthStart.cookies.find((cookie) => cookie.name === "oauth_state");
      const callback = await app.inject({
        method: "GET",
        url: `/auth/callback?code=github-code&state=${stateCookie?.value ?? ""}`,
        cookies: { oauth_state: stateCookie?.value ?? "" },
      });

      expect(callback.statusCode).toBe(502);
      expect(callback.json()).toEqual({ detail: "GitHub returned an invalid user profile" });
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds OAuth provider requests and reports timeouts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-provider-timeout-"));
    const { app, ports } = await makeProductionApp(dir, {
      githubClientId: "github-client",
      githubClientSecret: "github-secret",
      githubCallbackUrl: "https://print.example.com/auth/callback",
      githubOAuthConfigured: true,
      discordClientId: "discord-client",
      discordClientSecret: "discord-secret",
      discordCallbackUrl: "https://print.example.com/auth/discord/callback",
      discordOAuthConfigured: true,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    try {
      for (const oauth of [
        {
          provider: "GitHub",
          start: "/auth/github",
          callback: "/auth/callback",
        },
        {
          provider: "Discord",
          start: "/auth/discord",
          callback: "/auth/discord/callback",
        },
      ]) {
        const timeout = new Error("provider did not answer");
        timeout.name = "TimeoutError";
        fetchMock.mockRejectedValueOnce(timeout);

        const start = await app.inject({ method: "GET", url: oauth.start });
        const stateCookie = start.cookies.find((cookie) => cookie.name === "oauth_state");
        const callback = await app.inject({
          method: "GET",
          url: `${oauth.callback}?code=oauth-code&state=${stateCookie?.value ?? ""}`,
          cookies: { oauth_state: stateCookie?.value ?? "" },
        });

        expect(callback.statusCode).toBe(504);
        expect(callback.json()).toEqual({
          detail: `${oauth.provider} OAuth provider timed out`,
        });
        const requestInit = fetchMock.mock.calls.at(-1)?.[1];
        expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
      }
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reserves host slicer management for administrators", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-slicer-admin-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const admin = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "admin@example.com",
          password: "correct-horse-battery",
          display_name: "Admin",
        },
      });
      const member = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "member@example.com",
          password: "correct-horse-battery",
          display_name: "Member",
        },
      });
      const adminCookie = String(admin.headers["set-cookie"]).split(";", 1)[0];
      const memberCookie = String(member.headers["set-cookie"]).split(";", 1)[0];

      const forbidden = await app.inject({
        method: "GET",
        url: "/slicer-instances",
        headers: { cookie: memberCookie },
      });
      const allowed = await app.inject({
        method: "GET",
        url: "/slicer-instances",
        headers: { cookie: adminCookie },
      });

      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ detail: "Administrator access required" });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates a stored API key in the authenticated user's tenant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-tenant-key-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const registration = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "tenant-admin@example.com",
          password: "correct-horse-battery",
          display_name: "Tenant Admin",
        },
      });
      expect(registration.statusCode).toBe(200);
      const cookie = String(registration.headers["set-cookie"]).split(";", 1)[0];

      const created = await app.inject({
        method: "POST",
        url: "/settings/api-keys",
        headers: { cookie },
      });
      expect(created.statusCode).toBe(201);

      const api = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        headers: {
          authorization: `Bearer ${created.json().key}`,
          cookie,
        },
      });
      expect(api.statusCode).toBe(200);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

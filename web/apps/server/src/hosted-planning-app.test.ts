import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_PLANNING_CAPABILITY } from "@print-partner/contracts";
import { createSaasPorts } from "./adapters/saas/index.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HOSTED_LAN_DISABLED_DETAIL } from "./lib/hosted-planning-deny.js";
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
      expect(body.capabilities).not.toContain("mcp_http");
      expect(body.capabilities).not.toContain("backups");

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
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("authenticated single-user mode", () => {
  it("protects admin APIs, accepts one administrator, and reuses that session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-single-user-auth-"));
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const baseConfig = { ...loadConfig(), dataDir: dir };
    const legacyApp = await buildApp(
      { ...baseConfig, singleUserAuth: false, multiUser: false, authRequired: false },
      ports,
    );
    const createdPrinter = await legacyApp.inject({
      method: "POST",
      url: "/printers",
      payload: {
        name: "Existing printer",
        model: "Voron 2.4",
        bed_width_mm: 350,
        bed_depth_mm: 350,
        bed_height_mm: 330,
      },
    });
    expect(createdPrinter.statusCode).toBe(200);
    await legacyApp.close();

    const app = await buildApp(
      {
        ...baseConfig,
        singleUserAuth: true,
        multiUser: false,
        authRequired: true,
        sessionSecret: "test-session-secret",
      },
      ports,
    );
    cleanup.push(async () => {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const unauthorized = await app.inject({ method: "GET", url: "/settings/api-keys" });
    expect(unauthorized.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
      multi_user: false,
      authentication_required: true,
      registration_open: true,
    });

    const registration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "owner@example.com",
        password: "correct-horse-battery",
        display_name: "Owner",
      },
    });
    expect(registration.statusCode).toBe(200);
    const sessionCookie = registration.cookies.find((cookie) => cookie.name === "pp_session");
    expect(sessionCookie).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
      registration_open: false,
    });

    const authorized = await app.inject({
      method: "GET",
      url: "/settings/api-keys",
      cookies: { pp_session: sessionCookie?.value ?? "" },
    });
    expect(authorized.statusCode).toBe(200);

    const printers = await app.inject({
      method: "GET",
      url: "/printers",
      cookies: { pp_session: sessionCookie?.value ?? "" },
    });
    expect(printers.statusCode).toBe(200);
    expect(printers.json()).toMatchObject({
      printers: [{ name: "Existing printer", model: "Voron 2.4" }],
    });

    const secondRegistration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "second@example.com",
        password: "correct-horse-battery",
        display_name: "Second",
      },
    });
    expect(secondRegistration.statusCode).toBe(403);
  });
});

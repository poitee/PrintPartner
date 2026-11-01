/**
 * The desktop shell starts this server as its compatibility child with a cleared
 * environment plus the `Owner::Fixed` pairs in pp-compat's settings table. These
 * tests run the real app with exactly those pairs, so a change to the table is
 * checked against the routes it affects.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import { loadConfig, validateProductionConfig } from "./config.js";

const SETTINGS_TABLE = new URL(
  "../../../../rust/crates/pp-compat/src/settings.rs",
  import.meta.url,
);

function childFixedEnv(): Record<string, string> {
  const table = readFileSync(fileURLToPath(SETTINGS_TABLE), "utf8");
  return Object.fromEntries(
    [...table.matchAll(/\("([A-Z0-9_]+)", Owner::Fixed\("([^"]*)"\)\)/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

const savedEnv = { ...process.env };

function replaceEnv(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
  replaceEnv(savedEnv);
});

/** The desktop child with single-user sign-in on, which core may enable. */
async function startChild(env: Record<string, string>) {
  replaceEnv({ ...env, SINGLE_USER_AUTH: "1" });
  const dir = mkdtempSync(join(tmpdir(), "pp-desktop-child-env-"));
  const config = { ...loadConfig(), dataDir: dir };
  validateProductionConfig(config);
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => ports.db.close());
  cleanup.push(() => app.close());

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
  const reset = await app.inject({
    method: "POST",
    url: "/auth/forgot-password",
    headers: { host: "127.0.0.1:45678" },
    payload: { email: "owner@example.com" },
  });
  expect(reset.statusCode).toBe(200);
  return { app, config, reset: reset.json() as Record<string, unknown> };
}

describe("desktop compatibility child environment", () => {
  it("runs in production mode", () => {
    const env = childFixedEnv();
    expect(env).toMatchObject({ NODE_ENV: "production", DEPLOY_MODE: "self-host" });
    expect(env).not.toHaveProperty("PASSWORD_RESET_DEV_EXPOSE");
  });

  it("starts a mapped-account child without a session secret only under the desktop boundary", () => {
    replaceEnv(childFixedEnv());
    const config = { ...loadConfig(), multiUser: true, sessionSecret: null };

    expect(() => validateProductionConfig(config, { desktop: true })).not.toThrow();
    expect(() => validateProductionConfig(config)).toThrow("SESSION_SECRET is required");
  });

  it("never returns a password reset link and serves no development routes", async () => {
    const { app, config, reset } = await startChild(childFixedEnv());

    expect(config.passwordResetDevExpose).toBe(false);
    expect(reset).not.toHaveProperty("dev_reset_url");
    expect(JSON.stringify(reset)).not.toContain("token=");

    const devLogin = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { login: "attacker" },
    });
    expect(devLogin.statusCode).toBe(404);
    expect(app.hasRoute({ method: "POST", url: "/auth/dev-login" })).toBe(false);
    expect(app.hasRoute({ method: "GET", url: "/api/v1/docs" })).toBe(false);
  });

  it("would return the reset link and serve development routes if NODE_ENV were unset", async () => {
    const { NODE_ENV: _omitted, ...env } = childFixedEnv();
    const { app, reset } = await startChild(env);

    expect(reset).toMatchObject({
      dev_reset_url: expect.stringMatching(/\/reset-password\?token=/),
    });
    expect(app.hasRoute({ method: "POST", url: "/auth/dev-login" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/v1/docs" })).toBe(true);
  });
});

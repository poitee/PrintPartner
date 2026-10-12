import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { log } from "node:console";
import { chromium } from "playwright-core";
import { startServer } from "../../../server/dist/current/app.js";
import { loadConfig } from "../../../server/dist/current/config.js";
import { SqliteDatabase, getDb } from "../../../server/dist/current/db/client.js";
import { AuthStore } from "../../../server/dist/current/services/auth-store.js";
import { browserExecutable } from "./browserExecutable.mjs";

// Provision linked identities through the real store. This journey proves local
// session capability and Settings behavior; it does not claim live OAuth proof.
const data = await mkdtemp(join(tmpdir(), "pp-account-password-"));
const evidence = process.env.PP_ACCOUNT_PASSWORD_EVIDENCE;
let app;
let ports;
let browser;
let sqlite;
const receipts = [];
try {
  await access(fileURLToPath(new URL("../../dist/index.html", import.meta.url)));
  ({ app, ports } = await startServer({
    ...loadConfig(), dataDir: data, host: "127.0.0.1", port: 0,
    deployMode: "self-host", multiUser: true, singleUserAuth: false,
    authRequired: true, sessionSecret: "disposable-account-password-fixture",
    sessionCookieSecure: false, databaseUrl: null,
    staticDir: fileURLToPath(new URL("../../dist", import.meta.url)),
  }));
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await globalThis.fetch(`${origin}/health`)).status, 200);
  sqlite = new SqliteDatabase(data);
  sqlite.connect();
  const auth = new AuthStore(getDb(sqlite));
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const provider of ["github", "discord"]) {
    const email = `${provider}@example.com`;
    const registration = await globalThis.fetch(`${origin}/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, password: "password-before", display_name: `Linked ${provider}` }),
    });
    assert.equal(registration.status, 200);
    const registered = await registration.json();
    const linked = auth.upsertOAuthUser({ provider, providerUserId: `fixture-${provider}`,
      email, displayName: `Linked ${provider}` });
    assert.equal(linked.id, registered.user.user_id);
    const token = auth.createSession(linked.id, provider);
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
    try {
      await context.addCookies([{ name: "pp_session", value: token, url: origin }]);
      const page = await context.newPage();
      await page.goto(`${origin}/library`);
      await page.getByRole("link", { name: "Settings", exact: true }).first().click();
      await page.getByRole("heading", { name: "Account password", exact: true }).waitFor();
      const me = await (await context.request.get(`${origin}/auth/me`)).json();
      assert.equal(me.user.provider, provider);
      assert.equal(me.user.hasPassword, true);
      if (evidence) {
        await page.getByRole("navigation", { name: "Settings sections" })
          .getByRole("link", { name: "Account", exact: true }).click();
        await page.getByLabel("Current password", { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(evidence, `${provider}-linked-controls.png`), fullPage: true });
        await writeFile(join(evidence, `${provider}-linked-controls.aria.txt`), await page.locator("body").ariaSnapshot());
      }
      await page.getByLabel("Current password", { exact: true }).fill("password-before");
      await page.getByLabel("New password", { exact: true }).fill("password-after");
      await page.getByLabel("Confirm new password", { exact: true }).fill("password-after");
      const changed = page.waitForResponse((response) =>
        response.url() === `${origin}/auth/change-password`
        && response.request().method() === "POST");
      await page.getByRole("button", { name: "Update password", exact: true }).click();
      assert.equal((await changed).status(), 200);
      await page.goto(`${origin}/settings`);
      await page.getByRole("heading", { name: "Account password", exact: true }).waitFor();
      const after = await (await context.request.get(`${origin}/auth/me`)).json();
      assert.equal(after.user.provider, "email");
      assert.equal(after.user.hasPassword, true);
      const login = async (password) => globalThis.fetch(`${origin}/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ email, password }),
      });
      assert.equal((await login("password-before")).status, 401);
      assert.equal((await login("password-after")).status, 200);
      if (evidence) {
        await page.getByRole("navigation", { name: "Settings sections" })
          .getByRole("link", { name: "Account", exact: true }).click();
        await page.getByLabel("Current password", { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(evidence, `${provider}-password-controls.png`), fullPage: true });
        await writeFile(join(evidence, `${provider}-password-controls.aria.txt`), await page.locator("body").ariaSnapshot());
      }
      receipts.push({ provider, hasPassword: true, passwordControls: true,
        passwordUpdated: true, persistedAfterReload: true, oldPasswordRejected: true,
        sessionAfterPasswordChange: "email" });
    } finally { await context.close(); }
    const oauthOnly = auth.upsertOAuthUser({ provider, providerUserId: `only-${provider}`,
      email: null, displayName: "OAuth only" });
    const onlyContext = await browser.newContext();
    try {
      await onlyContext.addCookies([{ name: "pp_session", value: auth.createSession(oauthOnly.id, provider), url: origin }]);
      const page = await onlyContext.newPage();
      await page.goto(`${origin}/settings`);
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      const me = await (await onlyContext.request.get(`${origin}/auth/me`)).json();
      assert.equal(me.user.hasPassword, false);
      assert.equal(await page.getByRole("heading", { name: "Account password", exact: true }).count(), 0);
      assert.equal(await page.getByLabel("Current password", { exact: true }).count(), 0);
      receipts.push({ provider, hasPassword: false, passwordControls: false });
    } finally { await onlyContext.close(); }
  }
  if (evidence) await writeFile(join(evidence, "receipts.json"), JSON.stringify(receipts, null, 2));
  log(JSON.stringify({ journey: "linked account Settings password", receipts }));
} finally {
  await browser?.close();
  sqlite?.close();
  await app?.close();
  await ports?.db.close();
  await rm(data, { recursive: true, force: true });
}

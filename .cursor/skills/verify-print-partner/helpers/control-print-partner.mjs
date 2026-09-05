#!/usr/bin/env node
/**
 * Agent-friendly control CLI for Print Partner verification.
 * Verification scaffolding only — does not change product runtime behavior.
 *
 * Machine-readable JSON on stdout for every command.
 * Usage: node control-print-partner.mjs <command> [options]
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(SKILL_ROOT, "../../..");
const STATE_DIR =
  process.env.PP_VERIFY_STATE_DIR ||
  join(process.env.TMPDIR || "/tmp", "pp-verify");
const STATE_PATH = join(STATE_DIR, "state.json");
const DEFAULT_EVIDENCE_ROOT =
  process.env.PP_VERIFY_EVIDENCE_DIR ||
  join(process.env.TMPDIR || "/tmp", "pp-verify-evidence");

const requireFromWeb = createRequire(join(REPO_ROOT, "web/package.json"));

function emit(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
}

function fail(message, extra = {}, exitCode = 1) {
  emit({ ok: false, error: message, ...extra }, exitCode);
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function clearState() {
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function browserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function loadChromium() {
  try {
    const core = requireFromWeb("playwright-core");
    if (core?.chromium) return core.chromium;
  } catch {
    // fall through
  }
  try {
    const playwright = await import("playwright");
    if (playwright.chromium) return playwright.chromium;
  } catch {
    // fall through
  }
  throw new Error(
    "playwright-core not found. From web/: npm ci (or set PLAYWRIGHT_CHROMIUM_EXECUTABLE after installing web deps).",
  );
}

async function withBrowser(fn, { baseUrl, theme = "dark", profileId = null } = {}) {
  const chromium = await loadChromium();
  const executablePath = browserExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(
      ({ selectedTheme, selectedProfileId }) => {
        localStorage.setItem("print-partner.theme", selectedTheme);
        localStorage.setItem("print-partner.sidebar.ui.v1", "0");
        localStorage.setItem("print-partner.workflow.onboarding.v1", "1");
        if (selectedProfileId) {
          sessionStorage.setItem("pp-selected-profile-id", String(selectedProfileId));
        }
      },
      { selectedTheme: theme, selectedProfileId: profileId },
    );
    const page = await context.newPage();
    if (baseUrl) {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("#main-content", { state: "visible", timeout: 60_000 }).catch(() => {});
    }
    return await fn({ browser, context, page });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function waitForHealth(baseUrl, attempts = 60) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.ok) return body;
      }
    } catch {
      // retry
    }
    await delay(2000);
  }
  throw new Error(`App not healthy at ${baseUrl}/health after ${attempts} attempts`);
}

function composeArgs(state, extra = []) {
  return [
    "compose",
    "-p",
    state.project,
    "-f",
    join(SKILL_ROOT, "helpers/compose.verify.yml"),
    ...extra,
  ];
}

async function cmdLaunch(values) {
  const existing = readState();
  if (existing?.baseUrl) {
    try {
      const health = await waitForHealth(existing.baseUrl, 2);
      emit({
        ok: true,
        reused: true,
        ...existing,
        health,
        message: "Existing verification instance is healthy; reuse it or run cleanup first.",
      });
    } catch {
      // stale state — continue to relaunch
    }
  }

  const runId = randomUUID().slice(0, 8);
  const project = `pp-verify-${runId}`;
  const dataDir = resolve(
    values["data-dir"] || join(STATE_DIR, project, "data"),
  );
  const evidenceDir = resolve(
    values["evidence-dir"] || join(DEFAULT_EVIDENCE_ROOT, runId),
  );
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const mode = values.mode || "docker";
  if (mode === "docker") {
    const dockerCheck = run("docker", ["info"]);
    if (dockerCheck.status !== 0) {
      fail("Docker is not available. Start dockerd or use --mode npm.", {
        stderr: dockerCheck.stderr || dockerCheck.error,
      });
    }

    const env = {
      PP_VERIFY_DATA_DIR: dataDir,
      PP_BIND_ADDRESS: "127.0.0.1",
      COMPOSE_PROJECT_NAME: project,
    };

    const buildFlag = values["no-build"] ? [] : ["--build"];
    const up = run("docker", [
      ...composeArgs({ project }, ["up", "-d", ...buildFlag]),
    ], { env });
    if (up.status !== 0) {
      fail("docker compose up failed", { stdout: up.stdout, stderr: up.stderr });
    }

    const baseUrl = "http://127.0.0.1:8080";
    let health;
    try {
      health = await waitForHealth(baseUrl);
    } catch (err) {
      const logs = run("docker", composeArgs({ project }, ["logs", "--tail", "80"]), { env });
      fail(err.message, { logs: logs.stdout || logs.stderr });
    }

    const state = {
      ok: true,
      mode: "docker",
      runId,
      project,
      baseUrl,
      dataDir,
      evidenceDir,
      startedAt: new Date().toISOString(),
      composeFiles: ["helpers/compose.verify.yml"],
    };
    writeState(state);
    emit({ ...state, health, message: "Print Partner verification instance launched on :8080." });
    return;
  }

  // npm mode: isolated API + Vite (dev surface) — fallback when Docker is unavailable
  {
  const apiPort = Number(values["api-port"] || 18765);
  const uiPort = Number(values["ui-port"] || 5173);

  if (!existsSync(join(REPO_ROOT, "web/node_modules"))) {
    const ci = run("npm", ["ci"], { cwd: join(REPO_ROOT, "web") });
    if (ci.status !== 0) {
      fail("npm ci failed in web/", { stderr: ci.stderr });
    }
  }

  const { openSync, closeSync } = await import("node:fs");
  const logPath = join(STATE_DIR, project, "npm-dev.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  const dev = spawn("npm", ["run", "dev"], {
    cwd: join(REPO_ROOT, "web"),
    env: {
      ...process.env,
      PRINT_PARTNER_DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      VITE_DEV_API_TARGET: `http://127.0.0.1:${apiPort}`,
    },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  dev.unref();

  const baseUrl = `http://127.0.0.1:${uiPort}`;
  const healthUrl = `http://127.0.0.1:${apiPort}`;
  let health;
  try {
    health = await waitForHealth(healthUrl, 90);
  } catch (err) {
    fail(err.message, { logPath });
  }

  const state = {
    ok: true,
    mode: "npm",
    runId,
    project,
    baseUrl,
    healthUrl,
    dataDir,
    evidenceDir,
    pid: dev.pid,
    logPath,
    startedAt: new Date().toISOString(),
  };
  writeState(state);
  emit({ ...state, health, message: `Print Partner npm verification instance launched (UI ${uiPort}, API ${apiPort}).` });
  }
}

async function cmdDoctor() {
  const state = readState();
  if (!state) {
    fail("No verification state. Run launch first.");
  }

  const healthUrl = state.healthUrl || state.baseUrl;
  let health;
  try {
    const res = await fetch(`${healthUrl}/health`, { signal: AbortSignal.timeout(5000) });
    health = await res.json();
    if (!res.ok || !health?.ok) {
      fail("Health check failed", { health, state });
    }
  } catch (err) {
    fail(`Health request failed: ${err.message}`, { state });
  }

  const checks = {
    healthOk: Boolean(health?.ok),
    baseUrl: state.baseUrl,
    mode: state.mode,
    dataDirExists: existsSync(state.dataDir),
    evidenceDirExists: existsSync(state.evidenceDir),
    stateOwned: true,
  };

  if (state.mode === "docker") {
    const ps = run("docker", composeArgs(state, ["ps", "--status", "running", "-q"]));
    checks.composeRunning = ps.status === 0 && ps.stdout.trim().length > 0;
    if (!checks.composeRunning) {
      fail("Compose project is not running", { checks, state, ps: ps.stdout || ps.stderr });
    }
  } else if (state.pid) {
    try {
      process.kill(state.pid, 0);
      checks.processAlive = true;
    } catch {
      checks.processAlive = false;
      fail("npm verification process is not alive", { checks, state });
    }
  }

  // Probe UI root
  try {
    const pageRes = await fetch(state.baseUrl, { signal: AbortSignal.timeout(5000) });
    checks.uiReachable = pageRes.ok || pageRes.status === 200 || pageRes.status === 304;
  } catch (err) {
    checks.uiReachable = false;
    fail(`UI not reachable at ${state.baseUrl}: ${err.message}`, { checks, state });
  }

  emit({
    ok: true,
    doctor: "pass",
    checks,
    health,
    state: {
      runId: state.runId,
      mode: state.mode,
      baseUrl: state.baseUrl,
      dataDir: state.dataDir,
      evidenceDir: state.evidenceDir,
      project: state.project,
    },
  });
}

async function cmdNavigate(values) {
  const state = readState();
  if (!state) fail("No verification state. Run launch first.");
  const path = values.path || "/";
  const theme = values.theme || "dark";
  const profileId = values.profile || null;
  const url = new URL(path, state.baseUrl);
  if (profileId) url.searchParams.set("profile", profileId);

  const result = await withBrowser(
    async ({ page }) => {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("#main-content", { state: "visible", timeout: 60_000 });
      const title = await page.title();
      const heading = await page
        .getByRole("heading", { level: 1 })
        .first()
        .textContent()
        .catch(() => null);
      return {
        url: page.url(),
        title,
        heading: heading?.trim() ?? null,
      };
    },
    { baseUrl: state.baseUrl, theme, profileId },
  );

  emit({ ok: true, action: "navigate", path, ...result, evidenceDir: state.evidenceDir });
}

async function cmdScreenshot(values) {
  const state = readState();
  if (!state) fail("No verification state. Run launch first.");
  const path = values.path || "/";
  const theme = values.theme || "dark";
  const profileId = values.profile || null;
  const out = resolve(
    values.out ||
      join(state.evidenceDir, `screenshot-${Date.now()}.png`),
  );
  mkdirSync(dirname(out), { recursive: true });

  const url = new URL(path, state.baseUrl);
  if (profileId) url.searchParams.set("profile", profileId);

  const meta = await withBrowser(
    async ({ page }) => {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("#main-content", { state: "visible", timeout: 60_000 });
      await delay(Number(values.wait || 800));
      const heading = await page
        .getByRole("heading", { level: 1 })
        .first()
        .textContent()
        .catch(() => null);
      await page.screenshot({ path: out, fullPage: false });
      return {
        url: page.url(),
        heading: heading?.trim() ?? null,
        title: await page.title(),
      };
    },
    { baseUrl: state.baseUrl, theme, profileId },
  );

  emit({
    ok: true,
    action: "screenshot",
    out,
    exists: existsSync(out),
    theme,
    ...meta,
    evidenceDir: state.evidenceDir,
  });
}

async function cmdSnapshot(values) {
  const state = readState();
  if (!state) fail("No verification state. Run launch first.");
  const path = values.path || "/";
  const theme = values.theme || "dark";
  const profileId = values.profile || null;
  const out = resolve(
    values.out ||
      join(state.evidenceDir, `aria-${Date.now()}.txt`),
  );
  mkdirSync(dirname(out), { recursive: true });

  const url = new URL(path, state.baseUrl);
  if (profileId) url.searchParams.set("profile", profileId);

  const meta = await withBrowser(
    async ({ page }) => {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("#main-content", { state: "visible", timeout: 60_000 });
      await delay(Number(values.wait || 500));
      const snapshot = await page.locator("body").ariaSnapshot();
      writeFileSync(out, snapshot);
      const heading = await page
        .getByRole("heading", { level: 1 })
        .first()
        .textContent()
        .catch(() => null);
      return {
        url: page.url(),
        heading: heading?.trim() ?? null,
        lines: snapshot.split("\n").length,
      };
    },
    { baseUrl: state.baseUrl, theme, profileId },
  );

  emit({
    ok: true,
    action: "snapshot",
    out,
    exists: existsSync(out),
    ...meta,
    evidenceDir: state.evidenceDir,
  });
}

async function cmdClick(values) {
  const state = readState();
  if (!state) fail("No verification state. Run launch first.");
  const role = values.role || "button";
  const name = values.name;
  if (!name) fail("click requires --name");
  const path = values.path || null;
  const theme = values.theme || "dark";
  const profileId = values.profile || null;

  const meta = await withBrowser(
    async ({ page }) => {
      if (path) {
        const url = new URL(path, state.baseUrl);
        if (profileId) url.searchParams.set("profile", profileId);
        await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector("#main-content", { state: "visible", timeout: 60_000 });
      }
      const locator = page.getByRole(role, { name: new RegExp(name, "i") }).first();
      await locator.waitFor({ state: "visible", timeout: 30_000 });
      await locator.click();
      await delay(500);
      const heading = await page
        .getByRole("heading", { level: 1 })
        .first()
        .textContent()
        .catch(() => null);
      return { url: page.url(), heading: heading?.trim() ?? null };
    },
    { baseUrl: path ? undefined : state.baseUrl, theme, profileId },
  );

  emit({ ok: true, action: "click", role, name, ...meta });
}

async function cmdTheme(values) {
  const state = readState();
  if (!state) fail("No verification state. Run launch first.");
  const preference = values.preference || values.theme || "dark";
  if (!["system", "light", "dark"].includes(preference)) {
    fail("theme preference must be system|light|dark");
  }
  const out = values.out
    ? resolve(values.out)
    : join(state.evidenceDir, `theme-${preference}-${Date.now()}.png`);
  mkdirSync(dirname(out), { recursive: true });

  const meta = await withBrowser(
    async ({ page }) => {
      await page.goto(new URL("/settings", state.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector("#main-content", { state: "visible", timeout: 60_000 });
      const themeGroup = page.getByRole("group", { name: "Theme" });
      await themeGroup.waitFor({ state: "visible", timeout: 30_000 });
      // Segmented control options use title=Light/Dark/System
      const option = themeGroup.getByRole("radio", { name: new RegExp(preference, "i") })
        .or(themeGroup.getByTitle(new RegExp(`^${preference}$`, "i")))
        .or(themeGroup.locator(`[title="${preference[0].toUpperCase()}${preference.slice(1)}"]`));
      await option.first().click({ timeout: 15_000 }).catch(async () => {
        // Fallback: set via localStorage and reload (still observable via UI chrome)
        await page.evaluate((pref) => {
          localStorage.setItem("print-partner.theme", pref);
        }, preference);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#main-content", { state: "visible", timeout: 60_000 });
      });
      await delay(600);
      const stored = await page.evaluate(() => localStorage.getItem("print-partner.theme"));
      const darkClass = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      await page.screenshot({ path: out, fullPage: false });
      return {
        url: page.url(),
        stored,
        darkClass,
        heading: (
          await page.getByRole("heading", { level: 1 }).first().textContent().catch(() => null)
        )?.trim() ?? null,
      };
    },
    { theme: preference },
  );

  emit({
    ok: true,
    action: "theme",
    preference,
    out,
    exists: existsSync(out),
    ...meta,
  });
}

async function cmdCleanup(values) {
  const state = readState();
  if (!state) {
    emit({ ok: true, cleaned: false, message: "No verification state to clean." });
  }

  const keepEvidence = values["keep-evidence"] !== false;
  const evidenceDir = state.evidenceDir;
  const evidenceStillThere = evidenceDir && existsSync(evidenceDir);

  if (state.mode === "docker") {
    const down = run(
      "docker",
      composeArgs(state, ["down", "--volumes", "--remove-orphans"]),
      { env: { PP_VERIFY_DATA_DIR: state.dataDir, PP_BIND_ADDRESS: "127.0.0.1" } },
    );
    if (down.status !== 0) {
      fail("docker compose down failed", {
        stderr: down.stderr,
        evidenceDir,
        evidenceRetained: keepEvidence && evidenceStillThere,
      });
    }
  } else if (state.pid) {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await delay(1500);
  }

  // Remove disposable data dir, never evidence
  if (state.dataDir && existsSync(state.dataDir) && values["keep-data"] !== true) {
    rmSync(state.dataDir, { recursive: true, force: true });
  }

  clearState();

  emit({
    ok: true,
    cleaned: true,
    mode: state.mode,
    project: state.project,
    dataRemoved: values["keep-data"] !== true,
    evidenceDir,
    evidenceRetained: keepEvidence && existsSync(evidenceDir),
    message: "Verification instance torn down. Evidence directory retained.",
  });
}

function cmdHelp() {
  emit({
    ok: true,
    name: "control-print-partner",
    commands: [
      "launch [--mode docker|npm] [--no-build] [--data-dir DIR] [--evidence-dir DIR]",
      "doctor",
      "navigate --path /library [--theme dark|light] [--profile ID]",
      "screenshot --path /library [--out FILE] [--theme dark] [--profile ID] [--wait MS]",
      "snapshot --path /library [--out FILE] [--theme dark] [--profile ID]",
      "click --role link --name 'Source Library' [--path /builds]",
      "theme --preference dark|light|system [--out FILE]",
      "cleanup",
      "help",
    ],
    statePath: STATE_PATH,
    defaultEvidenceRoot: DEFAULT_EVIDENCE_ROOT,
    repoRoot: REPO_ROOT,
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      "no-build": { type: "boolean", default: false },
      "data-dir": { type: "string" },
      "evidence-dir": { type: "string" },
      path: { type: "string" },
      out: { type: "string" },
      theme: { type: "string" },
      preference: { type: "string" },
      profile: { type: "string" },
      wait: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      "api-port": { type: "string" },
      "ui-port": { type: "string" },
      "keep-data": { type: "boolean", default: false },
      "keep-evidence": { type: "boolean", default: true },
    },
  });

  const command = positionals[0] || "help";

  switch (command) {
    case "launch":
      await cmdLaunch(values);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "navigate":
      await cmdNavigate(values);
      break;
    case "screenshot":
      await cmdScreenshot(values);
      break;
    case "snapshot":
      await cmdSnapshot(values);
      break;
    case "click":
      await cmdClick(values);
      break;
    case "theme":
      await cmdTheme(values);
      break;
    case "cleanup":
      await cmdCleanup(values);
      break;
    case "help":
    default:
      cmdHelp();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), {
    stack: err instanceof Error ? err.stack : undefined,
  });
});

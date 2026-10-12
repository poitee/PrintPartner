#!/usr/bin/env node
/**
 * Hosted Postgres HTTP proof for PR264 P2 repo-manifest 503 at product f6.
 * In-process server lifecycle (no manual signals).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import pg from "pg";

const EXPECTED_DETAIL =
  "Source revision publication is unavailable on experimental PostgreSQL because atomic publication transactions are not supported.";
const PRODUCT_SHA = process.env.PRODUCT_GIT_SHA ?? "f6d4e394376031dd8da18995aa27154f0ea76483";
const PROOF_SHA = process.env.PROOF_GIT_SHA ?? "unknown";
const APP_ROOT = process.env.APP_ROOT;
const WEB_ROOT = process.env.WEB_ROOT;
const PROOF_ROOT = process.env.PROOF_ROOT ?? dirname(dirname(dirname(new URL(import.meta.url).pathname)));
const GIT_APP_ROOT = join(WEB_ROOT, "..");

const SOURCE_FINGERPRINTS = {
  "web/apps/server/src/routes/repo-manifest.ts": "e80d47647a43b36fd478f548bba44befb4ab07e2",
  "web/apps/server/src/services/local-source-revision.ts": "c77ca0190f073ccc8101a9167a31eb8517b59ac8",
};

const COMPILED_FINGERPRINTS = {
  "dist/current/routes/repo-manifest.js": "f8ce07645a1a7e4105152ff5750e32cb054aa50f7e2f788df3a74401bd0074c9",
  "dist/current/services/local-source-revision.js":
    "c216007b10b239d956cd181cb8570cc145474158e5ac24530d6b528745aa1f1d",
};

const OUT_DIR = join(PROOF_ROOT, ".github/scripts/out/pr264-postgres-proof");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitRevParse(cwd) {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function gitBlob(cwd, path) {
  return execFileSync("git", ["-C", cwd, "hash-object", path], { encoding: "utf8" }).trim();
}

function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value
      .replace(/set-cookie:[^\n]*/gi, "set-cookie: [REDACTED]")
      .replace(/("password"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
      .replace(/(session=)[^;\s"]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/cookie|password|secret|authorization/i.test(k)) out[k] = "[REDACTED]";
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function writeJson(name, data) {
  mkdirSync(OUT_DIR, { recursive: true });
  const text = JSON.stringify(redact(data), null, 2);
  writeFileSync(join(OUT_DIR, name), text);
  return text;
}

function treeDigest(root) {
  if (!existsSync(root)) return {};
  const files = {};
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else files[rel] = sha256File(abs);
    }
  };
  walk(root, "");
  return files;
}

function httpJson(port, method, path, { body, headers = {}, cookies = "" } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders["content-type"] = "application/json";
      reqHeaders["content-length"] = String(payload.length);
    }
    if (cookies) reqHeaders.cookie = cookies;
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: reqHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          const setCookie = res.headers["set-cookie"] ?? [];
          resolve({
            method,
            url: `http://127.0.0.1:${port}${path}`,
            status: res.statusCode,
            headers: { "set-cookie": setCookie },
            body: json,
            bodyText: text,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function mergeCookies(existing, setCookieHeader) {
  const jar = new Map();
  for (const part of (existing ? existing.split(";") : []).map((s) => s.trim()).filter(Boolean)) {
    const [k, ...rest] = part.split("=");
    if (k) jar.set(k, rest.join("="));
  }
  for (const line of setCookieHeader ?? []) {
    const first = line.split(";")[0];
    const [k, ...rest] = first.split("=");
    if (k) jar.set(k.trim(), rest.join("="));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function pgSnapshot(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const projects = await pool.query(
      "select id, name, local_path, current_source_revision_id from projects order by id",
    );
    const revisions = await pool.query(
      "select id, project_id, upstream_revision_key from source_revisions order by id",
    );
    return {
      projectCount: projects.rowCount,
      revisionCount: revisions.rowCount,
      projects: projects.rows,
      revisions: revisions.rows,
    };
  } finally {
    await pool.end();
  }
}

function assertFingerprints(report) {
  const appHead = gitRevParse(GIT_APP_ROOT);
  if (appHead !== PRODUCT_SHA) {
    throw new Error(`product git head ${appHead} != expected ${PRODUCT_SHA}`);
  }
  report.productGitHead = appHead;
  report.proofGitHead = existsSync(join(PROOF_ROOT, ".git"))
    ? gitRevParse(PROOF_ROOT)
    : PROOF_SHA;

  for (const [path, expected] of Object.entries(SOURCE_FINGERPRINTS)) {
    const abs = join(GIT_APP_ROOT, path);
    const blob = gitBlob(GIT_APP_ROOT, path);
    const mode = statSync(abs).mode & 0o777;
    report.sourceFingerprints ??= [];
    report.sourceFingerprints.push({ path, blob, mode: mode.toString(8), expected, ok: blob === expected });
    if (blob !== expected) throw new Error(`source fingerprint mismatch ${path}`);
  }
  for (const [rel, expected] of Object.entries(COMPILED_FINGERPRINTS)) {
    const abs = join(APP_ROOT, rel);
    const hash = sha256File(abs);
    report.compiledFingerprints ??= [];
    report.compiledFingerprints.push({ path: rel, sha256: hash, expected, ok: hash === expected });
    if (hash !== expected) throw new Error(`compiled fingerprint mismatch ${rel}`);
  }
}

async function main() {
  if (!APP_ROOT || !WEB_ROOT) throw new Error("APP_ROOT and WEB_ROOT are required");
  const report = {
    kind: "pr264-postgres-http-proof",
    productGitSha: PRODUCT_SHA,
    proofGitSha: PROOF_SHA,
    ppCommitEnv: process.env.PP_COMMIT ?? null,
    node: {
      version: process.version,
      abi: process.versions.modules,
      execPath: process.execPath,
      elf: execFileSync("file", ["-b", process.execPath], { encoding: "utf8" }).trim(),
    },
    atomicPublicationProven: false,
    ticketDoneClaimed: false,
    http: [],
    errors: [],
  };

  try {
    assertFingerprints(report);

    const runSalt = Number(process.env.GITHUB_RUN_ID ?? "0") % 20000;
    const port = 38000 + runSalt;
    process.env.HOST = "127.0.0.1";
    process.env.PORT = String(port);
    process.env.PRINT_PARTNER_DATA_DIR = join(OUT_DIR, "data");
    process.env.STATIC_DIR = join(WEB_ROOT, "apps/web/dist");
    process.env.ALLOWED_ORIGINS = `http://127.0.0.1:${port}`;
    if (!process.env.PP_COMMIT) process.env.PP_COMMIT = PRODUCT_SHA;

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");

    const beforeDb = await pgSnapshot(databaseUrl);
    report.dbBefore = beforeDb;

    const { startServer } = await import(pathToFileURL(join(APP_ROOT, "dist/current/app.js")).href);
    const { loadConfig } = await import(pathToFileURL(join(APP_ROOT, "dist/current/config.js")).href);
    const config = loadConfig();
    config.host = "127.0.0.1";
    config.port = port;
    config.dataDir = process.env.PRINT_PARTNER_DATA_DIR;

    const started = await startServer(config);
    const address = started.app.server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    report.listenPort = listenPort;

    try {
      const health = await httpJson(listenPort, "GET", "/health");
      report.http.push(health);
      if (health.status !== 200) throw new Error(`health status ${health.status}`);
      if (health.body?.db?.driver !== "postgres" || health.body?.db?.connected !== true) {
        throw new Error("health db not connected postgres");
      }
      if (health.body?.build?.commit !== PRODUCT_SHA) {
        throw new Error(`health build.commit ${health.body?.build?.commit} != ${PRODUCT_SHA}`);
      }

      const unauthPlans = await httpJson(listenPort, "GET", "/plans");
      report.http.push(unauthPlans);
      if (unauthPlans.status === 503) {
        throw new Error("unauthenticated /plans must not be blanket 503");
      }

      const email = `pr264-pg-proof-${runSalt}@example.com`;
      const password = "correct-horse-battery-staple-proof";
      let cookies = "";
      const register = await httpJson(listenPort, "POST", "/auth/register", {
        body: { email, password },
      });
      cookies = mergeCookies(cookies, register.headers["set-cookie"]);
      report.http.push({ ...register, requestBody: { email, password: "[REDACTED]" } });
      if (register.status !== 200 && register.status !== 201) {
        throw new Error(`register ${register.status} ${register.bodyText}`);
      }

      const createPlan = await httpJson(listenPort, "POST", "/plans", {
        body: { name: "Postgres proof control plan" },
        cookies,
      });
      cookies = mergeCookies(cookies, createPlan.headers["set-cookie"]);
      report.http.push(createPlan);
      if (createPlan.status !== 200 && createPlan.status !== 201) {
        throw new Error(`create plan ${createPlan.status}`);
      }

      const listPlans = await httpJson(listenPort, "GET", "/plans", { cookies });
      report.http.push(listPlans);
      if (listPlans.status !== 200) throw new Error(`list plans ${listPlans.status}`);

      const createSource = await httpJson(listenPort, "POST", "/sources", {
        body: { name: `pg-proof-source-${runSalt}`, source_kind: "local" },
        cookies,
      });
      report.http.push(createSource);
      if (createSource.status !== 200 && createSource.status !== 201) {
        throw new Error(`create source ${createSource.status} ${createSource.bodyText}`);
      }
      const sourceId = createSource.body?.id;
      if (!sourceId) throw new Error("missing source id");

      const reposDir = join(process.env.PRINT_PARTNER_DATA_DIR, "repos");
      const fsBefore = treeDigest(reposDir);
      report.fsBefore = fsBefore;

      const manifestYaml = "format: print-partner-manifest-v2\nversion: 2\nproject: pg-proof\nparts: []\n";
      const manifestPut = await httpJson(listenPort, "PUT", `/sources/${sourceId}/repo-manifest`, {
        body: { yaml: manifestYaml },
        cookies,
      });
      report.http.push(manifestPut);
      const manifestRepeat = await httpJson(listenPort, "PUT", `/sources/${sourceId}/repo-manifest`, {
        body: { yaml: manifestYaml },
        cookies,
      });
      report.http.push(manifestRepeat);

      const uploadFiles = await httpJson(listenPort, "POST", `/sources/${sourceId}/upload-files`, {
        body: { relative_paths: ["x.stl"], files: [] },
        cookies,
      });
      report.http.push(uploadFiles);

      const uploadZip = await httpJson(listenPort, "POST", `/sources/${sourceId}/upload-zip`, {
        body: {},
        cookies,
      });
      report.http.push(uploadZip);

      for (const row of [manifestPut, manifestRepeat, uploadFiles, uploadZip]) {
        if (row.status !== 503) throw new Error(`${row.method} ${row.url} expected 503 got ${row.status}`);
        if (row.body?.detail !== EXPECTED_DETAIL) {
          throw new Error(`503 detail mismatch on ${row.url}: ${row.body?.detail}`);
        }
      }

      const afterDb = await pgSnapshot(databaseUrl);
      report.dbAfter = afterDb;
      report.fsAfter = treeDigest(reposDir);

      if (afterDb.revisionCount !== beforeDb.revisionCount) {
        throw new Error("source_revisions mutated after unsupported ops");
      }

      report.pass = true;
      report.summary =
        "Live hosted Postgres HTTP: health connected, register/plan/list controls OK, repo-manifest and upload routes return 503 with publication-unavailable detail, DB revision count unchanged.";
    } finally {
      await started.app.close();
      await started.ports.db.close();
      report.serverClosed = true;
    }
  } catch (error) {
    report.pass = false;
    report.errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    writeJson("report.json", report);
    writeJson("http-transcript.json", report.http ?? []);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyReleasePlan,
  checkRelease,
  parseAppVersion,
  planRelease,
  renderReleaseIdentity,
  resolveTagCommit,
} from "./release.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function write(root, path, contents) {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "print-partner-release-"));
  write(root, "web/package.json", '{\n  "version": "3.1.0"\n}\n');
  write(
    root,
    "web/package-lock.json",
    '{\n  "version": "3.1.0",\n  "packages": { "": { "version": "3.1.0" }, "node_modules/example": { "version": "1.0.0" } }\n}\n',
  );
  write(root, "Dockerfile", "ARG PP_APP_VERSION=3.1.0\n");
  write(
    root,
    "docker-compose.yml",
    "image: example:${PRINT_PARTNER_VERSION:-3.1.0}\n# historical example: 3.1.0\n",
  );
  const versioned = (text) =>
    `<!-- release-version:start -->\n${text}\n<!-- release-version:end -->\n`;
  write(root, "README.md", versioned("Current release: 3.1.0. Runtime: 3.1.0-web."));
  write(
    root,
    "web/DEPLOY.md",
    `${versioned("Deploy 3.1.0 with PP_VERSION=3.1.0-web.")}Historical v3.1.0 incident.\n`,
  );
  write(root, "OPERATIONS.md", versioned("Version: 3.1.0"));
  write(
    root,
    "CHANGELOG.md",
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New work.\n\n## [3.1.0] - 2026-08-15\n\n- Old work.\n\n[3.1.0]: https://example.test/v3.1.0\n",
  );
  return root;
}

test("parseAppVersion accepts release SemVer and rejects tags or suffixes", () => {
  assert.equal(parseAppVersion("3.2.0"), "3.2.0");
  for (const invalid of ["v3.2.0", "3.2.0-web", "3.2", "03.2.0", "3.2.0-beta.1"]) {
    assert.throws(() => parseAppVersion(invalid), /version/i);
  }
});

test("release dry-run plan updates every current sink without writing", () => {
  const root = fixture();
  const before = readFileSync(join(root, "web/package.json"), "utf8");

  const plan = planRelease({ repoRoot: root, nextVersion: "3.2.0", date: "2026-08-20" });

  assert.equal(readFileSync(join(root, "web/package.json"), "utf8"), before);
  assert.deepEqual(
    plan.changes.map((change) => change.path),
    [
      "web/package.json",
      "web/package-lock.json",
      "Dockerfile",
      "docker-compose.yml",
      "README.md",
      "web/DEPLOY.md",
      "OPERATIONS.md",
      "CHANGELOG.md",
    ],
  );
});

test("release preparation rejects impossible calendar dates", () => {
  const root = fixture();
  assert.throws(
    () => planRelease({ repoRoot: root, nextVersion: "3.2.0", date: "2026-02-30" }),
    /release date/i,
  );
});

test("applying a release plan preserves private dependency versions and changelog history", () => {
  const root = fixture();
  const plan = planRelease({ repoRoot: root, nextVersion: "3.2.0", date: "2026-08-20" });
  applyReleasePlan(plan);

  const lock = JSON.parse(readFileSync(join(root, "web/package-lock.json"), "utf8"));
  assert.equal(lock.version, "3.2.0");
  assert.equal(lock.packages[""].version, "3.2.0");
  assert.equal(lock.packages["node_modules/example"].version, "1.0.0");
  assert.match(
    readFileSync(join(root, "docker-compose.yml"), "utf8"),
    /historical example: 3\.1\.0/,
  );

  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## \[Unreleased\]\n\n## \[3\.2\.0\] - 2026-08-20/);
  assert.match(changelog, /## \[3\.1\.0\] - 2026-08-15/);
  assert.match(changelog, /\[Unreleased\]: .*v3\.2\.0\.\.\.HEAD/);
  assert.match(changelog, /\[3\.2\.0\]: .*releases\/tag\/v3\.2\.0/);
  assert.match(
    readFileSync(join(root, "web/DEPLOY.md"), "utf8"),
    /Historical v3\.1\.0 incident/,
  );
});

test("release identity output is deterministic and binds the digest to the peeled commit", () => {
  const input = {
    version: "3.2.0",
    tag: "v3.2.0",
    commit: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
  };
  const first = renderReleaseIdentity(input);
  const second = renderReleaseIdentity(input);

  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first), {
    schema_version: 1,
    version: "3.2.0",
    runtime_version: "3.2.0-web",
    tag: "v3.2.0",
    commit: "a".repeat(40),
    image: {
      repository: "ghcr.io/poitee/print-partner",
      digest: `sha256:${"b".repeat(64)}`,
      expected_aliases: ["3.2.0"],
      mutable_aliases: ["latest"],
    },
    supported_deployment_modes: ["self-host"],
    github_release_url:
      "https://github.com/poitee/PrintPartner/releases/tag/v3.2.0",
  });
});

test("release guide asks maintainers for the next version", () => {
  const currentVersion = JSON.parse(readFileSync(join(REPO_ROOT, "web/package.json"), "utf8")).version;
  const deployGuide = readFileSync(join(REPO_ROOT, "web/DEPLOY.md"), "utf8");

  assert.doesNotMatch(
    deployGuide,
    new RegExp(`release\\.mjs prepare ${currentVersion.replaceAll(".", "\\.")}`),
  );
  assert.match(deployGuide, /NEXT_VERSION=X\.Y\.Z/);
});

test("annotated tag validation uses the peeled commit, not the tag object", () => {
  const root = mkdtempSync(join(tmpdir(), "print-partner-tag-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-test@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
  write(root, "tracked.txt", "one\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  execFileSync("git", ["tag", "-a", "v3.2.0", "-m", "Release v3.2.0"], { cwd: root });

  const tagObject = execFileSync("git", ["rev-parse", "refs/tags/v3.2.0"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const commit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();

  assert.notEqual(tagObject, commit);
  assert.equal(resolveTagCommit(root, "v3.2.0"), commit);
});

test("release check rejects a dirty worktree", () => {
  const root = fixture();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-test@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  assert.equal(checkRelease({ repoRoot: root }).version, "3.1.0");

  write(root, "README.md", `${readFileSync(join(root, "README.md"), "utf8")}dirty\n`);
  assert.throws(() => checkRelease({ repoRoot: root }), /working tree/i);
});

test("release check ignores commented versions and validates the active Docker argument", () => {
  const root = fixture();
  write(root, "Dockerfile", "# ARG PP_APP_VERSION=3.1.0\nARG PP_APP_VERSION=3.0.0\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-test@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });

  assert.throws(() => checkRelease({ repoRoot: root }), /Dockerfile PP_APP_VERSION/);
});

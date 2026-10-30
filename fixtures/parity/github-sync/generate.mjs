// Generates the GitHub sync parity golden (GRE-429) from Node's github-sync.ts,
// source-update-check.ts and repos-txt.ts. Run from the repo root after
// `npm --prefix web ci --ignore-scripts`:
//   node fixtures/parity/github-sync/generate.mjs          # write
//   node fixtures/parity/github-sync/generate.mjs --check  # verify, no writes
// The services import workspace TypeScript, so the generator reruns itself
// under web's tsx loader with the `development` export condition.
//
// GitHub is a stub: `globalThis.fetch` answers Octokit from `world` below and
// logs each read. `LocalSourceSnapshotStore.materialize` records the snapshot
// request syncGithubSource builds and publishes nothing, so no raw file is
// downloaded. Everything before the first download is Node's own code.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const output = join(here, "node.json");
const services = "web/apps/server/src/services";

const sha = (digit) => digit.repeat(40);
const blob = (path, size, blobSha = sha("b"), mode = "100644") => ({
  path,
  type: "blob",
  mode,
  size,
  sha: blobSha,
});

// Repositories the stub serves. `fail` maps a read to the HTTP status it answers.
const world = {
  "acme/kit": {
    default_branch: "main",
    branches: ["main", "feature", "feature/x", "release/v1"],
    tags: ["v1.0", "v2.0"],
    commits: {
      main: sha("1"),
      feature: sha("2"),
      "feature/x": sha("3"),
      "release/v1": sha("4"),
      "v1.0": sha("5"),
      "v2.0": sha("6"),
    },
    trees: {
      [sha("1")]: {
        tree: [
          { path: "parts", type: "tree", mode: "040000", sha: sha("c") },
          blob("parts/b.stl", 10, sha("d")),
          blob("parts/A.STL", 20, sha("e")),
          blob("README.md", 5),
          blob("docs/guide.md", 7),
          blob("docs/Manual.PDF", 9),
          blob("docs/readme.de.md", 3),
          blob("notes.txt", 4),
          blob("print-partner.manifest.yaml", 11),
          { path: "", type: "blob", mode: "100644", size: 1, sha: sha("f") },
          { path: "odd.stl", type: "weird", mode: "100644", size: 1, sha: sha("f") },
          blob("Bad-Sha.md", 2, "not-a-sha"),
        ],
        truncated: false,
      },
      [sha("2")]: {
        tree: [blob("feature.stl", 1), blob("pp-phases.json", 12), blob("print-partner.manifest.yaml", 8)],
        truncated: false,
      },
      [sha("3")]: { tree: [blob("x.stl", 1, sha("a"), "100755")], truncated: false },
      [sha("4")]: { tree: [blob("release.stl", 1)], truncated: true },
      [sha("5")]: { tree: [blob("tag.stl", 1)], truncated: false },
      [sha("6")]: { tree: [], truncated: false },
    },
  },
  "acme/edge": {
    default_branch: "trunk",
    branches: ["trunk"],
    tags: [],
    commits: {
      main: "NOT-A-SHA",
      trunk: sha("A"),
      dup: sha("7"),
      dupdiff: sha("8"),
      dupkind: sha("9"),
      dir: sha("0"),
      link: "0".repeat(39) + "1",
      sub: "0".repeat(39) + "2",
      phase: "0".repeat(39) + "3",
      stls: "0".repeat(39) + "4",
      budget: "0".repeat(39) + "5",
      meta: "0".repeat(39) + "6",
      unsafe: "0".repeat(39) + "7",
      nfd: "0".repeat(39) + "8",
      colon: "0".repeat(39) + "9",
      manifestdir: "0".repeat(38) + "10",
      order: "0".repeat(38) + "11",
      fold: "0".repeat(38) + "12",
    },
    trees: {
      [sha("A")]: { tree: [blob("trunk.stl", 1)], truncated: false },
      "NOT-A-SHA": { tree: [blob("x.stl", 1)], truncated: false },
      [sha("7")]: {
        tree: [blob("Part.stl", 1, sha("a")), blob("part.STL", 1, sha("A"))],
        truncated: false,
      },
      [sha("8")]: { tree: [blob("Part.stl", 1, sha("a")), blob("part.stl", 1, sha("b"))], truncated: false },
      [sha("9")]: { tree: [blob("Notes.md", 1, sha("a")), blob("notes.MD", 1, sha("a"))], truncated: false },
      [sha("0")]: { tree: [{ path: "dir.stl", type: "tree", mode: "040000", sha: sha("c") }], truncated: false },
      ["0".repeat(39) + "1"]: { tree: [blob("link.stl", 1, sha("a"), "120000")], truncated: false },
      ["0".repeat(39) + "2"]: {
        tree: [{ path: "vendor.md", type: "commit", mode: "160000", sha: sha("c") }],
        truncated: false,
      },
      ["0".repeat(39) + "3"]: { tree: [blob("pp-phases.json", 1024 * 1024 + 1)], truncated: false },
      ["0".repeat(39) + "4"]: { tree: [blob("a.stl", 1), blob("b.stl", 1)], truncated: false },
      ["0".repeat(39) + "5"]: {
        tree: [
          blob("pp-phases.json", 40),
          blob("a.md", 30),
          blob("B.md", 20),
          { path: "c.pdf", type: "blob", mode: "100644", sha: sha("b") },
          blob("d.md", 0),
          blob("e-notes.md", 10),
          blob("e_notes.md", 10),
          blob("README.md", 31),
        ],
        truncated: false,
      },
      ["0".repeat(39) + "6"]: {
        tree: [blob("print-partner.manifest.yaml", 60), blob("pp-phases.json", 50)],
        truncated: false,
      },
      ["0".repeat(39) + "7"]: { tree: [blob("parts/../x.stl", 1)], truncated: false },
      ["0".repeat(39) + "8"]: { tree: [blob("café.stl", 1)], truncated: false },
      ["0".repeat(39) + "9"]: { tree: [blob("part.stl:stream.md", 1)], truncated: false },
      ["0".repeat(38) + "10"]: {
        tree: [blob(".printpartner-source-snapshot.json/x.stl", 1)],
        truncated: false,
      },
      ["0".repeat(38) + "11"]: {
        tree: [
          blob("\u{1F600}.md", 1),
          blob("�.md", 1),
          blob("Zeta.md", 1),
          blob("alpha.md", 1),
          blob("_under.md", 1),
          blob("10.md", 1),
          blob("9.md", 1),
          blob("été.md", 1),
          blob("\u{1F600}.stl", 1),
          blob("�.stl", 1),
        ],
        truncated: false,
      },
      ["0".repeat(38) + "12"]: {
        tree: [blob("ΣΑΣ.stl", 1, sha("a")), blob("σας.stl", 1, sha("a"))],
        truncated: false,
      },
    },
  },
  "acme/down": {
    default_branch: "main",
    branches: [],
    tags: [],
    commits: { main: sha("1") },
    trees: {},
    fail: { branches: 503, tags: 500, commit: 502 },
  },
  "acme/nodefault": {
    default_branch: null,
    branches: ["dev"],
    tags: [],
    commits: {},
    trees: {},
  },
};

const urls = [
  { url: "https://github.com/acme/kit" },
  { url: "  https://github.com/acme/kit.git  ", requested: " dev " },
  { url: "http://www.github.com/acme/kit/" },
  { url: "HTTPS://GITHUB.COM/Acme/Kit.GIT" },
  { url: "https://github.com:443/acme/kit" },
  { url: "https://user:pw@github.com/acme/kit" },
  { url: "https://github.com/acme/kit?tab=readme#top" },
  { url: "https://github.com/acme" },
  { url: "https://gitlab.com/acme/kit" },
  { url: "ftp://github.com/acme/kit" },
  { url: "https://github.com/acme/.git" },
  { url: "https://github.com/acme%zz/kit" },
  { url: "https://github.com/ac%20me/k%C3%A9t" },
  { url: "https://github.com/acme/kit/issues/1" },
  { url: "https://github.com/acme/kit/tree" },
  { url: "https://github.com/acme/kit/tree/feature/x/parts", known: ["feature", "feature/x", " ", "feature/x/"] },
  { url: "https://github.com/acme/kit/TREE/feature/x", requested: "feature/x", known: ["main"] },
  { url: "https://github.com/acme/kit/blob/main/README.md", requested: "release", known: ["main"] },
  { url: "https://github.com/acme/kit/tree/feature%2Fx", requested: "feature/x", known: ["feature/x"] },
  { url: "https://github.com/acme/kit/tree/%E2%9C%93/a", requested: "✓", known: ["✓", "✓/a"] },
  { url: "https://github.com/acme/kit/tree/%ZZ/a", known: ["a"] },
  { url: "https://github.com\\acme\\kit\\tree\\main" },
  { url: "https://github.com/acme/kit/tree/a\tb", known: ["ab"] },
  { url: "git@github.com:acme/kit.git" },
  { url: "GIT@GITHUB.COM:Acme/Kit", requested: "dev" },
  { url: "git@github.com:acme/kit/extra" },
  { url: "git@github.com:acme/k it" },
  { url: "git@github.com:ac%20me/kit" },
  { url: "﻿https://github.com/acme/kit　" },
  { url: "\u0085https://github.com/acme/kit" },
  { url: "" },
  { url: "not a url" },
  { url: "https://github.com/acme/kit/tree/v1/a", requested: "", known: ["v1", "v1/a", "v1/a/b"] },
];

const reposLines = [
  "Alpha,https://github.com/a/b.git,dev",
  "  Beta , https://github.com/a/beta , ",
  "Gamma,https://github.com/a/g",
  "LDO-Extras,None,main",
  "Nil,NULL",
  "Empty,,main",
  ",https://github.com/a/noname",
  "# comment",
  "   ",
  "https://github.com/VoronDesign/Voron-Tap",
  "https://www.github.com/a/b.git/",
  "HTTP://GITHUB.COM/A/B",
  "https://github.com/a/b/tree/main",
  "https://github.com/a/b c",
  "git@github.com:a/b.git",
  "Delta,https://github.com/a/d,feature/x,extra",
];

const reposTexts = [
  "LDOVoron2,https://github.com/MotorDynamicsLab/LDOVoron2,main\r\nVoron-Stealthburner,https://github.com/VoronDesign/Voron-Stealthburner,main\nLDO-Extras,None,main\n# comment\nhttps://github.com/VoronDesign/Voron-Tap\n",
  "a,none\r\n,null\r\nb,\r\r\nc,https://github.com/a/c\n\n",
  "",
];

const listings = [
  "https://github.com/acme/kit",
  "https://github.com/acme/kit/tree/feature/x/parts",
  "https://github.com/acme/kit/tree/unknown/path",
  "https://github.com/acme/nodefault",
  "https://github.com/acme/down",
  "https://github.com/acme/missing",
  "https://gitlab.com/acme/kit",
];

const syncs = [
  { id: "default-branch", url: "https://github.com/acme/kit", branch: "main" },
  { id: "requested-branch", url: "https://github.com/acme/kit", branch: " feature " },
  { id: "tag-wins", url: "https://github.com/acme/kit", branch: "feature", tag: " v1.0 " },
  { id: "blank-tag", url: "https://github.com/acme/kit", branch: "feature", tag: "  " },
  { id: "deep-url-lists-branches", url: "https://github.com/acme/kit/tree/feature/x/parts", branch: "main" },
  { id: "deep-url-requested-match", url: "https://github.com/acme/kit/tree/feature/x", branch: "feature/x" },
  { id: "deep-url-exact-tail", url: "https://github.com/acme/kit/tree/feature", branch: "" },
  { id: "deep-url-branches-fail", url: "https://github.com/acme/down/tree/a/b", branch: "main" },
  { id: "truncated", url: "https://github.com/acme/kit", branch: "release/v1" },
  { id: "empty-tree", url: "https://github.com/acme/kit", branch: "main", tag: "v2.0" },
  { id: "invalid-sha", url: "https://github.com/acme/edge", branch: "main" },
  { id: "unknown-ref", url: "https://github.com/acme/edge", branch: "nope" },
  { id: "commit-fails", url: "https://github.com/acme/down", branch: "main" },
  { id: "missing-tree", url: "https://github.com/acme/nodefault", branch: "dev" },
  { id: "invalid-url", url: "https://example.com/acme/kit", branch: "main" },
  { id: "dup-identical", url: "https://github.com/acme/edge", branch: "dup" },
  { id: "dup-different", url: "https://github.com/acme/edge", branch: "dupdiff" },
  { id: "dup-docs", url: "https://github.com/acme/edge", branch: "dupkind" },
  { id: "dir-entry", url: "https://github.com/acme/edge", branch: "dir" },
  { id: "symlink", url: "https://github.com/acme/edge", branch: "link" },
  { id: "submodule", url: "https://github.com/acme/edge", branch: "sub" },
  { id: "phase-too-large", url: "https://github.com/acme/edge", branch: "phase" },
  { id: "stl-limit", url: "https://github.com/acme/edge", branch: "stls", options: { maxStlFiles: 1 } },
  { id: "stl-limit-exact", url: "https://github.com/acme/edge", branch: "stls", options: { maxStlFiles: 2 } },
  { id: "stl-limit-unsafe", url: "https://github.com/acme/edge", branch: "stls", options: { maxStlFiles: 2 ** 53 } },
  { id: "docs-limit-unsafe", url: "https://github.com/acme/edge", branch: "stls", options: { maxDocsBytes: 2 ** 53 } },
  { id: "timeout-zero", url: "https://github.com/acme/edge", branch: "stls", options: { fileTimeoutMs: 0 } },
  { id: "docs-budget", url: "https://github.com/acme/edge", branch: "budget", options: { maxDocsBytes: 100 } },
  { id: "docs-budget-zero", url: "https://github.com/acme/edge", branch: "budget", options: { maxDocsBytes: 40 } },
  { id: "metadata-over-budget", url: "https://github.com/acme/edge", branch: "meta", options: { maxDocsBytes: 100 } },
  { id: "unsafe-path", url: "https://github.com/acme/edge", branch: "unsafe" },
  { id: "nfd-path", url: "https://github.com/acme/edge", branch: "nfd" },
  { id: "colon-path", url: "https://github.com/acme/edge", branch: "colon" },
  { id: "manifest-dir", url: "https://github.com/acme/edge", branch: "manifestdir" },
  { id: "collation-order", url: "https://github.com/acme/edge", branch: "order", options: { maxDocsBytes: 5 } },
  { id: "final-sigma-fold", url: "https://github.com/acme/edge", branch: "fold" },
];

// Rows for one checkAllSourceUpdates run, in listSources order.
const updateRows = [
  { id: 1, name: "current", update_status: "up_to_date", row: { localPath: "/r/1", sourceKind: "github", sourceType: "git", url: "https://github.com/acme/kit", branch: "main", lastCommitSha: ` ${sha("1")} `, tag: null } },
  { id: 2, name: "behind", update_status: "up_to_date", row: { localPath: "/r/2", sourceKind: "GitHub", sourceType: null, url: "https://github.com/acme/kit", branch: "feature", lastCommitSha: sha("1"), tag: null } },
  { id: 3, name: "already-flagged", update_status: "updates_available", row: { localPath: "/r/3", sourceKind: "git", sourceType: "", url: "https://github.com/acme/kit", branch: null, lastCommitSha: sha("9"), tag: null } },
  { id: 4, name: "tagged", update_status: null, row: { localPath: "/r/4", sourceKind: "github", sourceType: "git", url: "https://github.com/acme/kit", branch: "main", lastCommitSha: sha("5"), tag: " v1.0 " } },
  { id: 5, name: "deep-url", update_status: null, row: { localPath: "/r/5", sourceKind: "github", sourceType: "git", url: "https://github.com/acme/kit/tree/feature/x/parts", branch: "feature/x", lastCommitSha: sha("3"), tag: "" } },
  { id: 6, name: "never-synced", update_status: null, row: { localPath: "/r/6", sourceKind: "github", sourceType: "git", url: "https://github.com/acme/kit", branch: "main", lastCommitSha: null, tag: null } },
  { id: 7, name: "read-fails", update_status: null, row: { localPath: "/r/7", sourceKind: "github", sourceType: "git", url: "https://github.com/acme/down", branch: "main", lastCommitSha: sha("1"), tag: null } },
  { id: 8, name: "not-github-url", update_status: null, row: { localPath: "/r/8", sourceKind: "git", sourceType: "git", url: "https://gitlab.com/acme/kit", branch: "main", lastCommitSha: sha("1"), tag: null } },
  { id: 9, name: "no-local-path", update_status: null, row: { localPath: null, sourceKind: "github", sourceType: "git", url: "https://github.com/acme/kit", branch: "main", lastCommitSha: sha("1"), tag: null } },
  { id: 10, name: "printables", update_status: null, row: { localPath: "/r/10", sourceKind: "printables", sourceType: "git", url: "https://github.com/acme/kit", branch: "main", lastCommitSha: sha("1"), tag: null } },
  { id: 11, name: "local-type", update_status: null, row: { localPath: "/r/11", sourceKind: "github", sourceType: "local", url: "https://github.com/acme/kit", branch: "main", lastCommitSha: sha("1"), tag: null } },
  { id: 12, name: "file-url", update_status: null, row: { localPath: "/r/12", sourceKind: "git", sourceType: "git", url: "file:///repos/kit", branch: "main", lastCommitSha: sha("1"), tag: null } },
  { id: 13, name: "missing-row", update_status: null, row: null },
];

function stubGithub(calls) {
  const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.github.com") throw new Error(`unexpected fetch ${url}`);
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const [, owner, repo, kind, ...rest] = parts;
    const read =
      kind === undefined ? ["repo", owner, repo]
      : kind === "branches" ? ["branches", owner, repo]
      : kind === "tags" ? ["tags", owner, repo]
      : kind === "commits" ? ["commit", owner, repo, rest.join("/")]
      : kind === "git" && rest[0] === "trees" ? ["tree", owner, repo, rest.slice(1).join("/")]
      : null;
    if (!read) throw new Error(`unexpected GitHub read ${url}`);
    if (read[0] === "tree" && url.searchParams.get("recursive") !== "true") {
      throw new Error(`tree read without recursive=true: ${url}`);
    }
    calls.push(read);
    const repoState = world[`${owner}/${repo}`];
    if (!repoState) return reply(404, { message: "Not Found" });
    const failed = repoState.fail?.[read[0]];
    if (failed) return reply(failed, { message: "stub failure" });
    switch (read[0]) {
      case "repo":
        return reply(200, { default_branch: repoState.default_branch });
      case "branches":
        return reply(200, repoState.branches.map((name) => ({ name })));
      case "tags":
        return reply(200, repoState.tags.map((name) => ({ name })));
      case "commit": {
        const commit = repoState.commits[read[3]];
        return commit ? reply(200, { sha: commit }) : reply(422, { message: "No commit found" });
      }
      case "tree": {
        const tree = repoState.trees[read[3]];
        return tree ? reply(200, { sha: read[3], ...tree }) : reply(404, { message: "Not Found" });
      }
    }
  };
}

function failure(error) {
  return typeof error?.status === "number" ? { status: error.status } : { message: error.message };
}

if (process.argv.includes("--probe")) {
  const sync = await import(pathToFileURL(join(root, services, "github-sync.ts")).href);
  const updates = await import(pathToFileURL(join(root, services, "source-update-check.ts")).href);
  const reposTxt = await import(pathToFileURL(join(root, services, "repos-txt.ts")).href);
  const { LocalSourceSnapshotStore } = await import(
    pathToFileURL(join(root, services, "local-source-snapshot.ts")).href
  );

  const urlCases = urls.map((input) => ({
    input,
    parsed: sync.parseGithubUrl(input.url),
    ref_name: sync.githubRefName(input.url, input.requested),
    location: sync.normalizeGithubSourceLocation(input.url, input.requested),
    resolved: sync.resolveGithubUrlRef(input.url, input.known ?? []),
  }));

  const reposLineCases = reposLines.map((line) => ({ line, parsed: reposTxt.parseReposTxtLine(line) }));
  const reposTextCases = reposTexts.map((text) => {
    const created = [];
    const repo = {
      listSources: () => [],
      createSource: (source) => {
        created.push(source.name);
        return { id: created.length };
      },
      updateSource: () => undefined,
    };
    const imported = reposTxt.importReposTxt(repo, text, {});
    return {
      text,
      parsed: reposTxt.parseReposTxtText(text),
      skipped: imported.skipped,
      skipped_names: imported.skipped_names,
    };
  });

  const calls = [];
  stubGithub(calls);
  const listed = async (read) => {
    calls.length = 0;
    let result;
    try {
      result = { ok: await read() };
    } catch (error) {
      result = { error: failure(error) };
    }
    return { ...result, calls: [...calls] };
  };
  const branchCases = [];
  for (const url of listings) branchCases.push({ url, ...(await listed(() => sync.listGithubBranches(url))) });
  const tagCases = [];
  for (const url of listings) tagCases.push({ url, ...(await listed(() => sync.listGithubTags(url))) });

  const materialize = LocalSourceSnapshotStore.prototype.materialize;
  let request;
  LocalSourceSnapshotStore.prototype.materialize = async function (input) {
    request = {
      upstreamRevisionKey: input.upstreamRevisionKey,
      files: input.files,
      selection: input.selection,
    };
    throw new Error("parity stub: snapshot not published");
  };
  const syncCases = [];
  for (const input of syncs) {
    request = undefined;
    calls.length = 0;
    let result;
    try {
      await sync.syncGithubSource({
        url: input.url,
        branch: input.branch,
        reposDir: "/nonexistent/parity-repos",
        sourceId: 1,
        options: { ...input.options, tag: input.tag },
      });
      throw new Error("parity stub did not stop the sync");
    } catch (error) {
      if (request) {
        const commit = calls.find((call) => call[0] === "commit");
        const tree = calls.find((call) => call[0] === "tree");
        if (!commit || !tree) throw new Error(`${input.id}: no commit or tree read`);
        result = { plan: { commitSha: tree[3], ...request } };
      } else {
        result = { error: failure(error) };
      }
    }
    syncCases.push({ input, ...result, calls: [...calls] });
  }
  LocalSourceSnapshotStore.prototype.materialize = materialize;

  calls.length = 0;
  const metadata = {};
  const events = [];
  const repo = {
    getSetting: () => null,
    setSetting: () => undefined,
    listSources: () => updateRows.map(({ id, name, update_status, row }) => ({ id, name, update_status, url: row?.url })),
    getProjectRow: (id) => updateRows.find((entry) => entry.id === id).row ?? undefined,
    updateSource: (id, patch) => {
      metadata[id] = patch.metadata.remote_update_status;
    },
    recordAppEvent: (event) => events.push(event.payload.source_id),
  };
  const checked = await updates.checkAllSourceUpdates(repo);
  const updateCase = {
    rows: updateRows,
    checked: checked.checked,
    skipped: checked.skipped,
    updates_available: checked.updates_available,
    checked_count: checked.checked_count,
    metadata,
    events,
    calls: [...calls],
  };

  process.stdout.write(
    `\n${JSON.stringify({
      world,
      urls: urlCases,
      repos_lines: reposLineCases,
      repos_texts: reposTextCases,
      branches: branchCases,
      tags: tagCases,
      syncs: syncCases,
      updates: updateCase,
    })}`,
  );
  process.exit(0);
}

const tsx = join(root, "web/node_modules/tsx/dist/esm/index.mjs");
const probe = JSON.parse(
  execFileSync(
    process.execPath,
    ["--conditions=development", "--import", pathToFileURL(tsx).href, fileURLToPath(import.meta.url), "--probe"],
    { cwd: join(root, "web/apps/server"), encoding: "utf8" },
  )
    .split("\n")
    .at(-1),
);
const generated = "@generated by fixtures/parity/github-sync/generate.mjs. Do not edit.";
// One case (or one `world` repository, or one update-check field) per line.
function format(value) {
  const lines = ["{"];
  const entries = Object.entries(value);
  entries.forEach(([key, item], index) => {
    const comma = index < entries.length - 1 ? "," : "";
    const nested = Array.isArray(item)
      ? item.map((element) => JSON.stringify(element))
      : item && typeof item === "object"
        ? Object.entries(item).map(([name, element]) => `${JSON.stringify(name)}: ${JSON.stringify(element)}`)
        : null;
    if (!nested) {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(item)}${comma}`);
      return;
    }
    const [open, close] = Array.isArray(item) ? ["[", "]"] : ["{", "}"];
    lines.push(`  ${JSON.stringify(key)}: ${open}`);
    nested.forEach((line, at) => lines.push(`    ${line}${at < nested.length - 1 ? "," : ""}`));
    lines.push(`  ${close}${comma}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
const text = format({ generated, ...probe });
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== text) throw new Error("github-sync/node.json is out of date");
} else {
  writeFileSync(output, text);
}
console.log(
  JSON.stringify({
    urls: probe.urls.length,
    repos_lines: probe.repos_lines.length,
    repos_texts: probe.repos_texts.length,
    branches: probe.branches.length,
    tags: probe.tags.length,
    syncs: probe.syncs.length,
    update_rows: probe.updates.rows.length,
    check: process.argv.includes("--check"),
  }),
);

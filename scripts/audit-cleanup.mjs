#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const trackedAndUntracked = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repoRoot, encoding: "utf8" },
);

if (trackedAndUntracked.status !== 0) {
  process.stderr.write(trackedAndUntracked.stderr);
  process.exit(trackedAndUntracked.status ?? 1);
}

const files = trackedAndUntracked.stdout
  .split("\0")
  .filter(Boolean)
  .filter((file) => {
    const absolute = join(repoRoot, file);
    return existsSync(absolute) && statSync(absolute).isFile();
  })
  .sort();
const fileSet = new Set(files.map((file) => normalize(file)));

const markdownFiles = files.filter((file) => extname(file).toLowerCase() === ".md");
const sourceFiles = files.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));

const hashes = new Map();
for (const file of files) {
  const absolute = join(repoRoot, file);
  const contents = readFileSync(absolute);
  if (contents.length === 0) continue;
  const hash = createHash("sha256").update(contents).digest("hex");
  const group = hashes.get(hash) ?? [];
  group.push(file);
  hashes.set(hash, group);
}

const duplicateGroups = [...hashes.values()]
  .filter((group) => group.length > 1)
  .sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));

const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
const brokenMarkdownLinks = [];
for (const file of markdownFiles) {
  const contents = readFileSync(join(repoRoot, file), "utf8");
  for (const match of contents.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    const target = rawTarget.split(/\s+["']/u, 1)[0];
    if (
      !target ||
      target.startsWith("#") ||
      /^(?:https?:|mailto:|data:)/i.test(target)
    ) {
      continue;
    }

    const pathOnly = decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]);
    const candidate = normalize(
      pathOnly.startsWith("/")
        ? pathOnly.slice(1)
        : join(dirname(file), pathOnly),
    );
    if (!fileSet.has(candidate) && !existsSync(join(repoRoot, candidate))) {
      brokenMarkdownLinks.push({ file, target: rawTarget });
    }
  }
}

const sourceSet = new Set(sourceFiles.map((file) => normalize(file)));
const inboundCounts = new Map(sourceFiles.map((file) => [normalize(file), 0]));
const moduleSpecifierPattern =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["']((?:\.{1,2}\/|@\/)[^"']+)["']/g;

function resolveModule(importer, specifier) {
  const base = normalize(
    specifier.startsWith("@/") && importer.startsWith("web/apps/web/")
      ? join("web/apps/web/src", specifier.slice(2))
      : join(dirname(importer), specifier),
  );
  const withoutRuntimeExtension = base.replace(/\.(?:[cm]?js|jsx)$/u, "");
  const candidates = [
    base,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    `${withoutRuntimeExtension}.mts`,
    `${withoutRuntimeExtension}.cts`,
    `${withoutRuntimeExtension}.js`,
    `${withoutRuntimeExtension}.jsx`,
    `${withoutRuntimeExtension}.mjs`,
    `${withoutRuntimeExtension}.cjs`,
    join(withoutRuntimeExtension, "index.ts"),
    join(withoutRuntimeExtension, "index.tsx"),
    join(withoutRuntimeExtension, "index.mts"),
    join(withoutRuntimeExtension, "index.cts"),
    join(withoutRuntimeExtension, "index.js"),
    join(withoutRuntimeExtension, "index.jsx"),
    join(withoutRuntimeExtension, "index.mjs"),
    join(withoutRuntimeExtension, "index.cjs"),
  ];
  return candidates.find((candidate) => sourceSet.has(candidate));
}

for (const importer of sourceFiles) {
  const contents = readFileSync(join(repoRoot, importer), "utf8");
  for (const match of contents.matchAll(moduleSpecifierPattern)) {
    const imported = resolveModule(importer, match[1]);
    if (imported) inboundCounts.set(imported, (inboundCounts.get(imported) ?? 0) + 1);
  }
}

const knownStandalonePatterns = [
  /(?:^|\/)test(?:s)?\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)(?:index|main|vite\.config|vitest\.config|eslint\.config)\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /(?:^|\/)scripts\//,
  /(?:^|\/)migrations\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)public\//,
];

const zeroInboundCandidates = [...inboundCounts.entries()]
  .filter(([file, count]) => count === 0 && !knownStandalonePatterns.some((pattern) => pattern.test(file)))
  .map(([file]) => file)
  .sort();

const report = {
  fileCount: files.length,
  markdownFileCount: markdownFiles.length,
  sourceFileCount: sourceFiles.length,
  duplicateGroups,
  brokenMarkdownLinks,
  zeroInboundCandidates,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `Files checked: ${report.fileCount}`,
      `Markdown files: ${report.markdownFileCount}`,
      `Source files: ${report.sourceFileCount}`,
      `Exact duplicate groups: ${report.duplicateGroups.length}`,
      `Broken local inline Markdown file targets: ${report.brokenMarkdownLinks.length}`,
      `Zero-inbound source candidates: ${report.zeroInboundCandidates.length}`,
      "",
      "Broken local inline Markdown file targets",
      ...report.brokenMarkdownLinks.map(({ file, target }) => `- ${file} -> ${target}`),
      "",
      "Zero-inbound source candidates",
      ...report.zeroInboundCandidates.map((file) => `- ${file}`),
      "",
      "Exact duplicate groups",
      ...report.duplicateGroups.slice(0, 50).map((group) => `- ${group.join(" | ")}`),
    ].join("\n"),
  );
}

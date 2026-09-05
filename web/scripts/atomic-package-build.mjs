import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const KEEP_RELEASES = 3;
const PUBLICATION_LOCK_NAME = ".publication-lock";
const PUBLICATION_LOCK_OWNER_FILE = "owner.json";
const PUBLICATION_LOCK_RETRY_DELAY_MS = 50;
const PUBLICATION_LOCK_WAIT_TIMEOUT_MS = 30 * 1_000;

function isFileSystemError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readLockOwner(lockDirectory) {
  try {
    return JSON.parse(
      await readFile(path.join(lockDirectory, PUBLICATION_LOCK_OWNER_FILE), "utf8"),
    );
  } catch {
    return null;
  }
}

async function acquirePublicationLock(releasesDirectory, options = {}) {
  const retryDelayMs = options.retryDelayMs ?? PUBLICATION_LOCK_RETRY_DELAY_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? PUBLICATION_LOCK_WAIT_TIMEOUT_MS;
  for (const [name, value] of Object.entries({ retryDelayMs, waitTimeoutMs })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Publication lock ${name} must be a non-negative finite number`);
    }
  }

  const lockDirectory = path.join(releasesDirectory, PUBLICATION_LOCK_NAME);
  const ownerToken = randomUUID();
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(lockDirectory);
      try {
        await writeFile(
          path.join(lockDirectory, PUBLICATION_LOCK_OWNER_FILE),
          `${JSON.stringify({ pid: process.pid, token: ownerToken })}\n`,
          { flag: "wx" },
        );
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = await readLockOwner(lockDirectory);
        if (
          typeof owner === "object" &&
          owner !== null &&
          "token" in owner &&
          owner.token === ownerToken
        ) {
          await rm(lockDirectory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }

    const remainingMs = waitTimeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for the package publication lock after ${waitTimeoutMs} ms. ` +
          `If no build is publishing, remove ${lockDirectory} manually.`,
      );
    }
    await delay(Math.min(retryDelayMs, remainingMs));
  }
}

async function withPublicationLock(releasesDirectory, options, publish) {
  const release = await acquirePublicationLock(releasesDirectory, options);
  try {
    return await publish();
  } finally {
    await release();
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `${path.basename(command)} exited with code ${String(code)}`
            : `${path.basename(command)} exited after signal ${signal}`,
        ),
      );
    });
  });
}

async function compileTypescript({ packageDirectory, project, outputDirectory }) {
  const require = createRequire(import.meta.url);
  const compiler = require.resolve("typescript/bin/tsc");
  await run(
    process.execPath,
    [
      compiler,
      "--project",
      project,
      "--outDir",
      outputDirectory,
      "--incremental",
      "--tsBuildInfoFile",
      path.join(outputDirectory, "tsconfig.tsbuildinfo"),
    ],
    packageDirectory,
  );
}

async function replaceLink({ linkPath, releaseDirectory, outputDirectory, temporaryLink }) {
  const target =
    process.platform === "win32"
      ? releaseDirectory
      : path.relative(outputDirectory, releaseDirectory);
  await symlink(target, temporaryLink, process.platform === "win32" ? "junction" : "dir");

  try {
    await rename(temporaryLink, linkPath);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "EEXIST" && error.code !== "EPERM")
    ) {
      throw error;
    }

    const priorLink = `${linkPath}.prior-${randomUUID()}`;
    await rename(linkPath, priorLink);
    try {
      await rename(temporaryLink, linkPath);
    } catch (replacementError) {
      await rename(priorLink, linkPath);
      throw replacementError;
    }
    return priorLink;
  }
}

async function removeLegacyOutput(outputDirectory) {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.name !== "current" &&
          entry.name !== "releases" &&
          !entry.name.startsWith(".current-"),
      )
      .map((entry) =>
        rm(path.join(outputDirectory, entry.name), { force: true, recursive: true }),
      ),
  );
}

function requiredBuildFilePath(outputDirectory, configuredPath) {
  if (!configuredPath || path.isAbsolute(configuredPath)) {
    throw new Error(`Required build file must be a relative path: ${String(configuredPath)}`);
  }
  const resolved = path.resolve(outputDirectory, configuredPath);
  const relative = path.relative(outputDirectory, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Required build file escapes the build directory: ${configuredPath}`);
  }
  return resolved;
}

async function assertRequiredBuildFiles(outputDirectory, requiredFiles) {
  for (const requiredFile of requiredFiles) {
    let entry;
    try {
      entry = await lstat(requiredBuildFilePath(outputDirectory, requiredFile));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Required build file ")) {
        throw error;
      }
      throw new Error(`Required build file is missing: ${requiredFile}`, { cause: error });
    }
    if (!entry.isFile()) {
      throw new Error(`Required build file is not a regular file: ${requiredFile}`);
    }
  }
}

async function pruneReleases({ outputDirectory, releasesDirectory, buildStartedAt }) {
  const currentTarget = await readlink(path.join(outputDirectory, "current"));
  const currentRelease = path.basename(currentTarget);
  const entries = await readdir(releasesDirectory, { withFileTypes: true });
  const releases = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("release-"))
      .map(async (entry) => ({
        name: entry.name,
        modifiedAt: (await stat(path.join(releasesDirectory, entry.name))).mtimeMs,
      })),
  );
  releases.sort((left, right) => right.modifiedAt - left.modifiedAt);

  const keep = new Set([
    currentRelease,
    ...releases.slice(0, KEEP_RELEASES).map((release) => release.name),
  ]);
  await Promise.all(
    releases
      .filter(
        (release) => !keep.has(release.name) && release.modifiedAt < buildStartedAt,
      )
      .map((release) =>
        rm(path.join(releasesDirectory, release.name), { recursive: true, force: true }),
      ),
  );
}

export async function buildPackageAtomically({
  packageDirectory,
  project,
  copies = [],
  requiredFiles = [],
  lockOptions,
  compile = async (outputDirectory) =>
    compileTypescript({ packageDirectory, project, outputDirectory }),
}) {
  const buildStartedAt = Date.now();
  const outputDirectory = path.join(packageDirectory, "dist");
  const releasesDirectory = path.join(outputDirectory, "releases");
  const buildId = `${Date.now().toString(36)}-${process.pid}-${randomUUID()}`;
  const pendingDirectory = path.join(releasesDirectory, `.pending-${buildId}`);
  const releaseDirectory = path.join(releasesDirectory, `release-${buildId}`);
  const temporaryLink = path.join(outputDirectory, `.current-${buildId}`);
  let publicationCommitted = false;

  await mkdir(releasesDirectory, { recursive: true });
  try {
    await compile(pendingDirectory);
    for (const copy of copies) {
      await cp(
        path.resolve(packageDirectory, copy.source),
        path.join(pendingDirectory, copy.target),
        { recursive: true },
      );
    }

    const entry = await lstat(path.join(pendingDirectory, "index.js"));
    if (!entry.isFile()) {
      throw new Error("TypeScript build did not emit index.js");
    }
    await assertRequiredBuildFiles(pendingDirectory, requiredFiles);

    await withPublicationLock(releasesDirectory, lockOptions, async () => {
      await rename(pendingDirectory, releaseDirectory);
      const priorLink = await replaceLink({
        linkPath: path.join(outputDirectory, "current"),
        releaseDirectory,
        outputDirectory,
        temporaryLink,
      });
      publicationCommitted = true;
      try {
        if (priorLink !== undefined) {
          await rm(priorLink, { force: true, recursive: true });
        }
        await removeLegacyOutput(outputDirectory);
        await pruneReleases({ outputDirectory, releasesDirectory, buildStartedAt });
      } catch (error) {
        throw new Error(
          `Package was published at ${releaseDirectory}, but cleanup failed`,
          { cause: error },
        );
      }
    });
  } finally {
    await rm(temporaryLink, { force: true, recursive: true });
    await rm(pendingDirectory, { force: true, recursive: true });
    if (!publicationCommitted) {
      await rm(releaseDirectory, { force: true, recursive: true });
    }
  }

  return releaseDirectory;
}

export function parseBuildArguments(args) {
  let project;
  const copies = [];
  const requiredFiles = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project") {
      project = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--copy") {
      const source = args[index + 1];
      const target = args[index + 2];
      if (source === undefined || target === undefined) {
        throw new Error("--copy requires a source and target");
      }
      copies.push({ source, target });
      index += 2;
      continue;
    }
    if (argument === "--require-file") {
      const requiredFile = args[index + 1];
      if (requiredFile === undefined) {
        throw new Error("--require-file requires a path");
      }
      requiredFiles.push(requiredFile);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(argument)}`);
  }

  if (project === undefined) {
    throw new Error("--project is required");
  }
  return { project, copies, requiredFiles };
}

const isCommand = process.argv[1] === fileURLToPath(import.meta.url);
if (isCommand) {
  const options = parseBuildArguments(process.argv.slice(2));
  await buildPackageAtomically({ packageDirectory: process.cwd(), ...options });
}

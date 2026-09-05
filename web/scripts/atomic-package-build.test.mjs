import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import test from "node:test";

import { buildPackageAtomically } from "./atomic-package-build.mjs";

async function makePackage() {
  const packageDirectory = await mkdtemp(join(tmpdir(), "print-partner-build-"));
  await writeFile(join(packageDirectory, "tsconfig.json"), "{}\n");
  return packageDirectory;
}

async function readCurrent(packageDirectory, path) {
  return readFile(join(packageDirectory, "dist", "current", path), "utf8");
}

test("publishes a complete build at one switch point", async (context) => {
  const packageDirectory = await makePackage();
  context.after(() => rm(packageDirectory, { recursive: true, force: true }));
  await buildPackageAtomically({
    packageDirectory,
    project: "tsconfig.json",
    compile: async (outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "index.js"), "old entry\n");
      await writeFile(join(outputDirectory, "dependency.js"), "old dependency\n");
    },
  });

  let finishCompile;
  const compilePaused = new Promise((resolve) => {
    finishCompile = resolve;
  });
  let entryWritten;
  const entryIsWritten = new Promise((resolve) => {
    entryWritten = resolve;
  });

  const nextBuild = buildPackageAtomically({
    packageDirectory,
    project: "tsconfig.json",
    compile: async (outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "index.js"), "new entry\n");
      entryWritten();
      await compilePaused;
      await writeFile(join(outputDirectory, "dependency.js"), "new dependency\n");
    },
  });

  await entryIsWritten;
  assert.equal(await readCurrent(packageDirectory, "index.js"), "old entry\n");
  assert.equal(await readCurrent(packageDirectory, "dependency.js"), "old dependency\n");

  finishCompile();
  await nextBuild;
  assert.equal(await readCurrent(packageDirectory, "index.js"), "new entry\n");
  assert.equal(await readCurrent(packageDirectory, "dependency.js"), "new dependency\n");
});

test("keeps the prior build when compilation fails", async (context) => {
  const packageDirectory = await makePackage();
  context.after(() => rm(packageDirectory, { recursive: true, force: true }));
  await buildPackageAtomically({
    packageDirectory,
    project: "tsconfig.json",
    compile: async (outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "index.js"), "working\n");
    },
  });

  await assert.rejects(
    buildPackageAtomically({
      packageDirectory,
      project: "tsconfig.json",
      compile: async (outputDirectory) => {
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, "index.js"), "broken\n");
        throw new Error("compiler failed");
      },
    }),
    /compiler failed/,
  );

  assert.equal(await readCurrent(packageDirectory, "index.js"), "working\n");
});

test("keeps the prior build when a required runtime asset is missing", async (context) => {
  const packageDirectory = await makePackage();
  context.after(() => rm(packageDirectory, { recursive: true, force: true }));
  await buildPackageAtomically({
    packageDirectory,
    project: "tsconfig.json",
    compile: async (outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "index.js"), "working\n");
    },
  });

  await assert.rejects(
    buildPackageAtomically({
      packageDirectory,
      project: "tsconfig.json",
      requiredFiles: ["data/path-hints.yaml"],
      compile: async (outputDirectory) => {
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, "index.js"), "incomplete\n");
      },
    }),
    /required build file is missing.*data\/path-hints\.yaml/i,
  );

  assert.equal(await readCurrent(packageDirectory, "index.js"), "working\n");
});

test("retains a committed Windows release when prior junction cleanup fails", async (context) => {
  const packageDirectory = await makePackage();
  context.after(() => rm(packageDirectory, { recursive: true, force: true }));
  await buildPackageAtomically({
    packageDirectory,
    project: "tsconfig.json",
    compile: async (outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "index.js"), "working\n");
    },
  });

  const require = createRequire(import.meta.url);
  const fsPromises = require("node:fs/promises");
  const nativeRename = rename;
  const nativeRm = rm;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  let rejectedInitialReplacement = false;
  let rejectedPriorCleanup = false;

  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  fsPromises.rename = async (source, destination) => {
    if (
      !rejectedInitialReplacement &&
      String(source).includes(".current-") &&
      String(destination).endsWith("current")
    ) {
      rejectedInitialReplacement = true;
      const error = new Error("simulated Windows junction replacement");
      error.code = "EEXIST";
      throw error;
    }
    return nativeRename(source, destination);
  };
  fsPromises.rm = async (target, options) => {
    if (String(target).includes(".prior-")) {
      rejectedPriorCleanup = true;
      const error = new Error("simulated prior junction cleanup failure");
      error.code = "EPERM";
      throw error;
    }
    return nativeRm(target, options);
  };
  syncBuiltinESMExports();

  try {
    const cleanupError = await buildPackageAtomically({
      packageDirectory,
      project: "tsconfig.json",
      compile: async (outputDirectory) => {
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, "index.js"), "committed\n");
      },
    }).then(
      () => null,
      (error) => error,
    );

    const currentLink = join(packageDirectory, "dist", "current");
    const currentTarget = await readlink(currentLink);
    const currentRelease = isAbsolute(currentTarget)
      ? currentTarget
      : join(packageDirectory, "dist", currentTarget);
    assert.equal(rejectedInitialReplacement, true);
    assert.equal(rejectedPriorCleanup, true);
    assert.equal((await lstat(currentRelease)).isDirectory(), true);
    assert.equal(await readCurrent(packageDirectory, "index.js"), "committed\n");
    assert(cleanupError instanceof Error);
    assert.match(cleanupError.message, /published.*cleanup failed/i);
    assert.equal(cleanupError.cause?.message, "simulated prior junction cleanup failure");
  } finally {
    fsPromises.rename = nativeRename;
    fsPromises.rm = nativeRm;
    Object.defineProperty(process, "platform", platformDescriptor);
    syncBuiltinESMExports();
  }
});

test("serializes concurrent publication and pruning", async (context) => {
  const packageDirectory = await makePackage();
  context.after(() => rm(packageDirectory, { recursive: true, force: true }));

  const buildCount = 32;
  let stagedBuilds = 0;
  let releaseCompiles;
  const compilesMayFinish = new Promise((resolve) => {
    releaseCompiles = resolve;
  });
  let allBuildsStaged;
  const allBuildsAreStaged = new Promise((resolve) => {
    allBuildsStaged = resolve;
  });
  const builds = Array.from({ length: buildCount }, (_, index) =>
    buildPackageAtomically({
      packageDirectory,
      project: "tsconfig.json",
      compile: async (outputDirectory) => {
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, "index.js"), `build ${index}\n`);
        await utimes(outputDirectory, new Date(0), new Date(0));
        stagedBuilds += 1;
        if (stagedBuilds === buildCount) allBuildsStaged();
        await compilesMayFinish;
      },
    }),
  );

  await allBuildsAreStaged;
  releaseCompiles();
  await Promise.all(builds);

  assert.match(await readCurrent(packageDirectory, "index.js"), /^build \d+\n$/);
});

test("refuses to publish through an active package lock", async (context) => {
  const packageDirectory = await makePackage();
  context.after(() => rm(packageDirectory, { recursive: true, force: true }));
  await buildPackageAtomically({
    packageDirectory,
    project: "tsconfig.json",
    compile: async (outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "index.js"), "working\n");
    },
  });
  await mkdir(join(packageDirectory, "dist", "releases", ".publication-lock"));
  let compiled = false;

  await assert.rejects(
    buildPackageAtomically({
      packageDirectory,
      project: "tsconfig.json",
      lockOptions: { waitTimeoutMs: 0, retryDelayMs: 1 },
      compile: async (outputDirectory) => {
        compiled = true;
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, "index.js"), "must not publish\n");
      },
    }),
    /timed out waiting for the package publication lock/i,
  );
  assert.equal(compiled, true);
  assert.equal(await readCurrent(packageDirectory, "index.js"), "working\n");
});

test("fails closed when concurrent builds find an abandoned stale publication lock", async (context) => {
  const packageDirectory = await makePackage();
  context.after(() => rm(packageDirectory, { recursive: true, force: true }));
  const lockDirectory = join(packageDirectory, "dist", "releases", ".publication-lock");
  await buildPackageAtomically({
    packageDirectory,
    project: "tsconfig.json",
    compile: async (outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "index.js"), "working\n");
    },
  });
  await mkdir(lockDirectory);
  await utimes(lockDirectory, new Date(0), new Date(0));

  let stagedBuilds = 0;
  let releaseCompiles;
  const compilesMayFinish = new Promise((resolve) => {
    releaseCompiles = resolve;
  });
  let bothBuildsStaged;
  const bothBuildsAreStaged = new Promise((resolve) => {
    bothBuildsStaged = resolve;
  });
  const builds = ["first", "second"].map((label) =>
    buildPackageAtomically({
      packageDirectory,
      project: "tsconfig.json",
      lockOptions: { waitTimeoutMs: 20, retryDelayMs: 1 },
      compile: async (outputDirectory) => {
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, "index.js"), `${label} contender\n`);
        stagedBuilds += 1;
        if (stagedBuilds === 2) bothBuildsStaged();
        await compilesMayFinish;
      },
    }),
  );

  await bothBuildsAreStaged;
  releaseCompiles();
  const results = await Promise.allSettled(builds);

  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  for (const result of results) {
    assert.match(result.reason.message, /timed out waiting for the package publication lock/i);
  }
  assert.equal(await readCurrent(packageDirectory, "index.js"), "working\n");
  assert.equal((await lstat(lockDirectory)).isDirectory(), true);
});

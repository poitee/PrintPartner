import { spawn } from "node:child_process";
import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_MEDIA_PNG_MAX_BYTES,
  acceptedMediaBasis,
  acceptedMediaCachePath,
  observeAcceptedMediaPng,
  readAcceptedMediaPng,
  removeAcceptedMediaPng,
  writeAcceptedMediaPng,
} from "./accepted-media-cache.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
  };
});

const temporaryRoots: string[] = [];
const basis = "b".repeat(64);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("accepted thumbnail"),
]);

function cacheFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "print-partner-accepted-media-"));
  temporaryRoots.push(root);
  return join(root, "thumbs");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("acceptedMediaBasis", () => {
  it("returns the full canonical content basis", () => {
    const basis = acceptedMediaBasis({
      expectedSha256: "a".repeat(64),
      role: " Primary ",
      hex: "#ABCDEF",
      variant: "thumbnail",
    });

    expect(basis).toBe("45845a1f88700fea820122a66735163f0553d932bb688ecf0a0242cd55239c6e");
    expect(basis).toHaveLength(64);
  });

  it("changes with every derivative input and normalizes equivalent display values", () => {
    const original = acceptedMediaBasis({
      expectedSha256: "a".repeat(64),
      role: "primary",
      hex: "#abcdef",
      variant: "thumbnail",
    });
    const equivalent = acceptedMediaBasis({
      expectedSha256: "a".repeat(64),
      role: " PRIMARY ",
      hex: "ABCDEF",
      variant: "thumbnail",
    });
    const changed = [
      acceptedMediaBasis({
        expectedSha256: "b".repeat(64),
        role: "primary",
        hex: "#abcdef",
        variant: "thumbnail",
      }),
      acceptedMediaBasis({
        expectedSha256: "a".repeat(64),
        role: "accent",
        hex: "#abcdef",
        variant: "thumbnail",
      }),
      acceptedMediaBasis({
        expectedSha256: "a".repeat(64),
        role: "primary",
        hex: "#fedcba",
        variant: "thumbnail",
      }),
      acceptedMediaBasis({
        expectedSha256: "a".repeat(64),
        role: "primary",
        hex: "#abcdef",
        variant: "preview",
      }),
    ];

    expect(equivalent).toBe(original);
    expect(new Set([original, ...changed]).size).toBe(5);
  });

  it("rejects malformed derivative inputs", () => {
    expect(() =>
      acceptedMediaBasis({
        expectedSha256: "A".repeat(64),
        role: "primary",
        hex: null,
        variant: "mesh",
      }),
    ).toThrow("artifact digest");
    expect(() =>
      acceptedMediaBasis({
        expectedSha256: "a".repeat(64),
        role: " \0 ",
        hex: null,
        variant: "mesh",
      }),
    ).toThrow("media role");
    expect(() =>
      acceptedMediaBasis({
        expectedSha256: "a".repeat(64),
        role: "primary",
        hex: "#12345g",
        variant: "thumbnail",
      }),
    ).toThrow("media color");
  });
});

describe("accepted media PNG cache", () => {
  it("keeps one shared cache descriptor validation seam", () => {
    const source = readFileSync(new URL("./accepted-media-cache.ts", import.meta.url), "utf8");

    expect(source.match(/lstatSync\(resolve\(input\.thumbsDir\)\)/g)).toHaveLength(2);
    expect(source.match(/opened\.dev !== beforeOpen\.dev/g)).toHaveLength(1);
  });

  it("observes a valid signature without reading the PNG body", () => {
    const thumbsDir = cacheFixture();
    writeAcceptedMediaPng({ thumbsDir, basis, png });
    const read = vi.mocked(readSync);
    read.mockClear();

    expect(observeAcceptedMediaPng({ thumbsDir, basis })).toEqual({ kind: "present" });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1].byteLength).toBe(8);
  });

  it("accepts the exact observation limit and rejects one byte beyond it", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    const exact = Buffer.concat([png.subarray(0, 8), Buffer.alloc(24)]);
    writeFileSync(acceptedMediaCachePath({ thumbsDir, basis }), exact);

    expect(observeAcceptedMediaPng({ thumbsDir, basis, maxBytes: exact.length })).toEqual({
      kind: "present",
    });
    expect(observeAcceptedMediaPng({ thumbsDir, basis, maxBytes: exact.length - 1 })).toEqual({
      kind: "missing",
    });
  });

  it("does not retry a stable invalid signature during observation", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    writeFileSync(
      acceptedMediaCachePath({ thumbsDir, basis }),
      Buffer.alloc(ACCEPTED_MEDIA_PNG_MAX_BYTES, 0x41),
    );
    const read = vi.mocked(readSync);
    read.mockClear();

    expect(observeAcceptedMediaPng({ thumbsDir, basis })).toEqual({ kind: "missing" });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("bounds observation retries when descriptor identity keeps racing", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    writeFileSync(acceptedMediaCachePath({ thumbsDir, basis }), png);
    const otherPath = join(thumbsDir, "other-observation.png");
    writeFileSync(otherPath, png);
    const otherStats = statSync(otherPath);
    const descriptorStats = vi.mocked(fstatSync);
    descriptorStats.mockClear();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      descriptorStats.mockImplementationOnce(() => otherStats);
    }

    expect(observeAcceptedMediaPng({ thumbsDir, basis })).toEqual({ kind: "missing" });

    expect(descriptorStats).toHaveBeenCalledTimes(8);
  });

  it("writes and reads a mode-0600 PNG without leaving temporary files", () => {
    const thumbsDir = cacheFixture();

    writeAcceptedMediaPng({ thumbsDir, basis, png });

    expect(readAcceptedMediaPng({ thumbsDir, basis })).toEqual(png);
    expect(readdirSync(thumbsDir)).toEqual([`${basis}.png`]);
    expect(statSync(acceptedMediaCachePath({ thumbsDir, basis })).mode & 0o777).toBe(0o600);
  });

  it("preserves the prior target and removes its temporary file when publication fails", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    const target = acceptedMediaCachePath({ thumbsDir, basis });
    mkdirSync(target);
    const sentinel = join(target, "prior-target");
    writeFileSync(sentinel, "prior bytes");

    expect(() => writeAcceptedMediaPng({ thumbsDir, basis, png })).toThrow();

    expect(readFileSync(sentinel, "utf8")).toBe("prior bytes");
    expect(readdirSync(thumbsDir)).toEqual([`${basis}.png`]);
  });

  it("removes only the requested accepted media basis", () => {
    const thumbsDir = cacheFixture();
    const otherBasis = "c".repeat(64);
    writeAcceptedMediaPng({ thumbsDir, basis, png });
    writeAcceptedMediaPng({ thumbsDir, basis: otherBasis, png });

    expect(removeAcceptedMediaPng({ thumbsDir, basis })).toBe(true);
    expect(removeAcceptedMediaPng({ thumbsDir, basis })).toBe(false);
    expect(readAcceptedMediaPng({ thumbsDir, basis: otherBasis })).toEqual(png);
  });

  it("fails closed for absent, malformed, symlinked, and non-directory roots", () => {
    const absentRoot = cacheFixture();
    expect(removeAcceptedMediaPng({ thumbsDir: absentRoot, basis })).toBe(false);
    expect(() => removeAcceptedMediaPng({ thumbsDir: absentRoot, basis: "not-a-basis" })).toThrow(
      "Invalid accepted media basis",
    );

    const symlinkRoot = cacheFixture();
    const outsideDirectory = join(symlinkRoot, "..", "outside-cache");
    mkdirSync(outsideDirectory);
    const outsideTarget = acceptedMediaCachePath({ thumbsDir: outsideDirectory, basis });
    writeFileSync(outsideTarget, png);
    symlinkSync(outsideDirectory, symlinkRoot, "dir");

    expect(removeAcceptedMediaPng({ thumbsDir: symlinkRoot, basis })).toBe(false);
    expect(readFileSync(outsideTarget)).toEqual(png);

    const fileRoot = cacheFixture();
    writeFileSync(fileRoot, "not a directory");
    expect(removeAcceptedMediaPng({ thumbsDir: fileRoot, basis })).toBe(false);
  });

  it("unlinks a contained final-entry symlink without touching its target", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    const outsideTarget = join(thumbsDir, "..", "outside-thumbnail.png");
    writeFileSync(outsideTarget, png);
    const cachePath = acceptedMediaCachePath({ thumbsDir, basis });
    symlinkSync(outsideTarget, cachePath);

    expect(removeAcceptedMediaPng({ thumbsDir, basis })).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
    expect(readFileSync(outsideTarget)).toEqual(png);
  });

  it("reads a maximum-size invalid signature only once", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    writeFileSync(
      acceptedMediaCachePath({ thumbsDir, basis }),
      Buffer.alloc(ACCEPTED_MEDIA_PNG_MAX_BYTES, 0x41),
    );
    const read = vi.mocked(readSync);
    read.mockClear();

    expect(readAcceptedMediaPng({ thumbsDir, basis })).toBeNull();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("bounds retries when the opened descriptor identity keeps racing", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    writeFileSync(acceptedMediaCachePath({ thumbsDir, basis }), png);
    const otherPath = join(thumbsDir, "other.png");
    writeFileSync(otherPath, png);
    const otherStats = statSync(otherPath);
    const descriptorStats = vi.mocked(fstatSync);
    descriptorStats.mockClear();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      descriptorStats.mockImplementationOnce(() => otherStats);
    }

    expect(readAcceptedMediaPng({ thumbsDir, basis })).toBeNull();

    expect(descriptorStats).toHaveBeenCalledTimes(8);
  });

  it("exposes only complete old or new bytes while another process publishes", async () => {
    const thumbsDir = cacheFixture();
    const nextPng = Buffer.concat([
      png.subarray(0, 8),
      Buffer.from("replacement accepted thumbnail"),
    ]);
    writeAcceptedMediaPng({ thumbsDir, basis, png });
    const moduleUrl = new URL("./accepted-media-cache.ts", import.meta.url).href;
    const script = `
      import { writeAcceptedMediaPng } from ${JSON.stringify(moduleUrl)};
      const thumbsDir = process.env.PP_ACCEPTED_MEDIA_TEST_ROOT;
      const basis = process.env.PP_ACCEPTED_MEDIA_TEST_BASIS;
      const oldPng = process.env.PP_ACCEPTED_MEDIA_TEST_OLD;
      const newPng = process.env.PP_ACCEPTED_MEDIA_TEST_NEW;
      if (!thumbsDir || !basis || !oldPng || !newPng) throw new Error("Missing test input");
      const oldBytes = Buffer.from(oldPng, "base64");
      const newBytes = Buffer.from(newPng, "base64");
      process.send("ready");
      process.once("message", (message) => {
        if (message !== "start") throw new Error("Expected start");
        writeAcceptedMediaPng({ thumbsDir, basis, png: newBytes });
        process.send("published");
        process.once("message", (release) => {
          if (release !== "release") throw new Error("Expected release");
          for (let index = 0; index < 100; index += 1) {
            writeAcceptedMediaPng({
              thumbsDir,
              basis,
              png: index % 2 === 0 ? oldBytes : newBytes,
            });
          }
          process.disconnect();
        });
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PP_ACCEPTED_MEDIA_TEST_ROOT: thumbsDir,
          PP_ACCEPTED_MEDIA_TEST_BASIS: basis,
          PP_ACCEPTED_MEDIA_TEST_OLD: png.toString("base64"),
          PP_ACCEPTED_MEDIA_TEST_NEW: nextPng.toString("base64"),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    let ready = false;
    let published = false;
    child.on("message", (message) => {
      if (message === "ready") ready = true;
      if (message === "published") published = true;
    });
    let sawOld = false;
    let sawNew = false;
    let absentReads = 0;
    let partialReads = 0;
    let reading = true;
    let readerError: unknown;
    const reader = (async () => {
      try {
        while (reading) {
          const current = readAcceptedMediaPng({ thumbsDir, basis });
          if (current == null) absentReads += 1;
          else if (current.equals(png)) sawOld = true;
          else if (current.equals(nextPng)) sawNew = true;
          else partialReads += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } catch (error) {
        readerError = error;
      }
    })();
    const waitFor = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (!condition() && child.exitCode === null && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    let exitCode: number | null;
    try {
      await waitFor(() => ready);
      expect(ready, stderr).toBe(true);
      expect(sawOld).toBe(true);
      expect(child.send("start")).toBe(true);
      await waitFor(() => published);
      expect(published, stderr).toBe(true);
      await waitFor(() => sawNew);
      expect(sawNew).toBe(true);
      expect(child.send("release")).toBe(true);
      exitCode = await completed;
    } finally {
      reading = false;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await reader;
    }

    if (readerError !== undefined) throw readerError;
    expect(exitCode, stderr).toBe(0);
    expect(absentReads).toBe(0);
    expect(partialReads).toBe(0);
    expect(sawOld).toBe(true);
    expect(sawNew).toBe(true);
  }, 15_000);

  it("returns null for absent, malformed, non-file, symlinked, and oversized entries", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    const path = acceptedMediaCachePath({ thumbsDir, basis });

    expect(readAcceptedMediaPng({ thumbsDir, basis })).toBeNull();
    writeFileSync(path, Buffer.from("not a png"));
    expect(readAcceptedMediaPng({ thumbsDir, basis })).toBeNull();
    rmSync(path);
    mkdirSync(path);
    expect(readAcceptedMediaPng({ thumbsDir, basis })).toBeNull();
    rmSync(path, { recursive: true });

    const outside = join(thumbsDir, "..", "outside.png");
    writeFileSync(outside, png);
    symlinkSync(outside, path);
    expect(readAcceptedMediaPng({ thumbsDir, basis })).toBeNull();
    rmSync(path);

    writeFileSync(path, png);
    expect(readAcceptedMediaPng({ thumbsDir, basis, maxBytes: png.length - 1 })).toBeNull();
  });

  it("rejects invalid writes before creating a cache directory", () => {
    const thumbsDir = cacheFixture();

    expect(() =>
      writeAcceptedMediaPng({
        thumbsDir,
        basis,
        png: Buffer.from("not a png"),
      }),
    ).toThrow("Invalid accepted media PNG");
    expect(existsSync(thumbsDir)).toBe(false);
    expect(() =>
      writeAcceptedMediaPng({
        thumbsDir,
        basis,
        png,
        maxBytes: png.length - 1,
      }),
    ).toThrow("exceeds size limit");
    expect(existsSync(thumbsDir)).toBe(false);
  });

  it("rejects malformed basis paths without touching the filesystem", () => {
    const thumbsDir = cacheFixture();

    expect(() => acceptedMediaCachePath({ thumbsDir, basis: "../escape" })).toThrow(
      "Invalid accepted media basis",
    );
    expect(() =>
      writeAcceptedMediaPng({ thumbsDir, basis: "../escape", png }),
    ).toThrow("Invalid accepted media basis");
    expect(existsSync(thumbsDir)).toBe(false);
  });

  it("replaces a cache symlink without writing through it", () => {
    const thumbsDir = cacheFixture();
    mkdirSync(thumbsDir);
    const outside = join(thumbsDir, "..", "outside.png");
    const originalOutside = Buffer.from("outside stays unchanged");
    writeFileSync(outside, originalOutside);
    symlinkSync(outside, acceptedMediaCachePath({ thumbsDir, basis }));

    writeAcceptedMediaPng({ thumbsDir, basis, png });

    expect(readFileSync(outside)).toEqual(originalOutside);
    expect(readAcceptedMediaPng({ thumbsDir, basis })).toEqual(png);
  });

  it("rejects a symlinked cache root", () => {
    const thumbsDir = cacheFixture();
    const realCache = join(thumbsDir, "..", "real-cache");
    mkdirSync(realCache);
    symlinkSync(realCache, thumbsDir);

    expect(readAcceptedMediaPng({ thumbsDir, basis })).toBeNull();
    expect(() => writeAcceptedMediaPng({ thumbsDir, basis, png })).toThrow(
      "Invalid accepted media cache root",
    );
    expect(readdirSync(realCache)).toEqual([]);
  });
});

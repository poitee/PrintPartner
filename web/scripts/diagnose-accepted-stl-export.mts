import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { AcceptedExportPart, CaptureAcceptedOperationalExportResult } from "../apps/server/src/services/accepted-operational-export.js";

const serverRequire = createRequire(new URL("../apps/server/package.json", import.meta.url));
const AdmZip: new (bytes: Buffer) => {
  getEntries(): Array<{ entryName: string; isDirectory: boolean; getData(): Buffer }>;
} = serverRequire("adm-zip");

const bytes = Buffer.from("accepted-stl");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
type ExportResult = Awaited<ReturnType<typeof import("../apps/server/src/services/export-stl-pack.js").materializeAcceptedStlBundle>>;

function options() {
  let units = 10_001;
  let scratchParent = tmpdir();
  const seen = new Set<string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    assert(flag && value && !seen.has(flag), "Expected unique --units and --scratch-parent flags with values");
    seen.add(flag);
    if (flag === "--units") {
      assert(/^[1-9]\d*$/.test(value), "--units must be a positive integer");
      units = Number(value);
      assert(Number.isSafeInteger(units) && units <= 10_001, "--units must be at most 10001");
    } else if (flag === "--scratch-parent") {
      scratchParent = value;
    } else {
      throw new Error(`Unknown option ${flag}`);
    }
  }
  scratchParent = fs.realpathSync(resolve(scratchParent));
  assert(fs.statSync(scratchParent).isDirectory(), "--scratch-parent must be an existing directory");
  return { units, scratchParent };
}

function fixture(root: string, units: number) {
  const reposDir = join(root, "repos");
  const snapshotRoot = join(reposDir, "snapshots", "one");
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(join(snapshotRoot, "widget.stl"), bytes);
  const part: AcceptedExportPart = {
    revisionPartId: 31, projectionPartId: 131, partKey: "part:31",
    relativePath: "widget.stl", filename: "widget.stl", sourceLayer: "base:Fixture",
    status: "ok", role: "accent", filamentColorId: null, filamentCustomHex: null,
    spoolmanSpoolId: null, quantityInferred: 1, quantityOverride: null,
    quantityEffective: units, included: true, notes: "", geometrySame: null,
    requirement: null, optionGroupId: null, manifestSource: null,
    artifact: {
      kind: "tracked", sourceId: 1, sourceRevisionId: 2, snapshotRoot,
      relativePath: "widget.stl", expectedSha256: sha256(bytes),
    },
    units: Array.from({ length: units }, (_, unitIndex) => ({
      token: `31:${unitIndex}`, unitIndex, completed: false, assembled: false,
    })),
  };
  const capture: Extract<CaptureAcceptedOperationalExportResult, { kind: "ready" }> = {
    kind: "ready",
    export: {
      basis: {
        profileId: 7, planVersion: 4, revisionId: 19,
        revisionDigest: "a".repeat(64), requiredUnitMappingDigest: "b".repeat(64),
      },
      profile: {
        id: 7, name: "Accepted Build", orderNumber: null,
        specialRequest: null, archivedAt: null,
      },
      provenance: { kind: "legacy" }, parts: [part],
    },
  };
  return {
    capture, reposDir, tenantExportsDir: join(root, "exports"),
    selection: "all", groupBy: "color_dir",
    roleOrder: ["primary", "accent", "clear", "opaque"],
  } satisfies Parameters<typeof import("../apps/server/src/services/export-stl-pack.js").materializeAcceptedStlBundle>[0];
}

function contained(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function instrument(root: string) {
  const originalFsync = fs.fsync;
  const originalReadStream = fs.createReadStream;
  const flush = {
    calls: 0, callbacks: 0, errors: 0, synchronousThrows: 0,
    inflight: 0, maxInflight: 0, callbackLatencyTotalMs: 0, callbackLatencyMaxMs: 0,
  };
  const zipSources = { created: 0, opened: 0, ended: 0, errors: 0, bytesRead: 0 };
  let firstZipSourceAt: number | null = null;
  fs.fsync = Object.assign((descriptor: number, callback: Parameters<typeof originalFsync>[1]) => {
    const start = performance.now();
    flush.calls++;
    flush.inflight++;
    flush.maxInflight = Math.max(flush.maxInflight, flush.inflight);
    try {
      originalFsync(descriptor, (error) => {
        const latency = performance.now() - start;
        flush.callbacks++;
        flush.inflight--;
        if (error) flush.errors++;
        flush.callbackLatencyTotalMs += latency;
        flush.callbackLatencyMaxMs = Math.max(flush.callbackLatencyMaxMs, latency);
        callback(error);
      });
    } catch (error) {
      flush.inflight--;
      flush.synchronousThrows++;
      throw error;
    }
  }, originalFsync);
  fs.createReadStream = (...args) => {
    const [path] = args;
    const isZipSource = typeof path === "string" && contained(root, path)
      && relative(root, path).split(sep).some((segment) => segment.startsWith(".tmp-"))
      && path.endsWith(".stl");
    if (isZipSource) {
      firstZipSourceAt ??= performance.now();
      zipSources.created++;
    }
    const stream = originalReadStream(...args);
    if (isZipSource) {
      stream.once("open", () => { zipSources.opened++; });
      stream.once("end", () => {
        zipSources.ended++;
        zipSources.bytesRead += stream.bytesRead;
      });
      stream.once("error", () => { zipSources.errors++; });
    }
    return stream;
  };
  syncBuiltinESMExports();
  return {
    flush, zipSources,
    firstZipSourceAt: () => firstZipSourceAt,
    restore() {
      fs.fsync = originalFsync;
      fs.createReadStream = originalReadStream;
      syncBuiltinESMExports();
    },
  };
}

function validate(root: string, result: ExportResult, units: number) {
  assert.equal(result.kind, "materialized", "Exporter must return materialized");
  assert(result.kind === "materialized");
  assert(contained(root, result.rootPath), "Publication must stay inside the fixture");
  assert(result.bundlePath && contained(result.rootPath, result.bundlePath));
  assert.equal(result.bundlePath, join(result.rootPath, "accepted-stl.zip"));
  assert.deepEqual(result.fileCounts, { accent: units });
  assert.deepEqual(result.warnings, []);
  let looseFileCount = 0;
  let looseBytes = 0;
  const identities: Array<{ relativePath: string; size: number; sha256: string }> = [];
  const walk = (directory: string) => {
    assert(!fs.lstatSync(directory).isSymbolicLink(), "Unexpected directory symlink");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      assert(entry.isFile(), "Unexpected output entry type");
      const content = fs.readFileSync(path);
      const relativePath = relative(result.rootPath, path).split(sep).join("/");
      identities.push({ relativePath, size: content.length, sha256: sha256(content) });
      if (path === result.bundlePath) continue;
      assert.match(relativePath, /^accent\/_root\/widget_\d+\.stl$/);
      assert.deepEqual(content, bytes, `Incorrect loose content at ${relativePath}`);
      looseFileCount++;
      looseBytes += content.length;
    }
  };
  walk(result.rootPath);
  assert.equal(looseFileCount, units);
  assert.equal(looseBytes, units * bytes.length);
  const expectedNames = new Set(Array.from({ length: units }, (_, index) =>
    `accent/_root/widget_${String(index + 1).padStart(2, "0")}.stl`));
  const looseNames = new Set(identities.filter((file) => file.relativePath !== "accepted-stl.zip").map((file) => file.relativePath));
  assert.deepEqual(looseNames, expectedNames, "Incorrect loose filenames");
  const zipBytes = fs.readFileSync(result.bundlePath);
  const entries = new AdmZip(zipBytes).getEntries();
  assert.equal(entries.length, units);
  for (const entry of entries) {
    assert(!entry.isDirectory && expectedNames.delete(entry.entryName), "Unexpected or duplicate ZIP entry");
    assert.deepEqual(entry.getData(), bytes, `Incorrect ZIP content at ${entry.entryName}`);
  }
  assert.equal(expectedNames.size, 0, "Missing ZIP entries");
  const publicationBasename = basename(result.rootPath);
  const expectedPublication = `content-${sha256(JSON.stringify({
    files: identities.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    warnings: [],
  }))}`;
  assert.equal(publicationBasename, expectedPublication, "Publication identity mismatch");
  return {
    kind: "valid", looseFileCount, looseBytes, zipEntryCount: entries.length,
    decompressedBytes: units * bytes.length, zipBytes: zipBytes.length,
    zipSha256: sha256(zipBytes), publicationBasename,
  };
}

type MeasurementReport = {
  kind: "measurement"; node: string; units: number; sourceBytes: number;
  scratchParent: string; scratchRoot: string;
  filesystem: { type: number; typeHex: string; blockSize: number } | null;
  method: Record<string, string>;
  export: {
    resultKind: string; elapsedMs: number; cpuUserMs: number; cpuSystemMs: number;
    copiesUntilFirstZipSourceMs: number | null; firstZipSourceUntilResultMs: number | null;
  } | null;
  flush: ReturnType<typeof instrument>["flush"] | null;
  zipSources: ReturnType<typeof instrument>["zipSources"] | null;
  validation: ReturnType<typeof validate> | null;
  cleanup: { removed: boolean; error: string | null };
  error: string | null;
};

async function main() {
  const { units, scratchParent } = options();
  const root = fs.mkdtempSync(join(scratchParent, "gre928-synthetic-"));
  const report: MeasurementReport = {
    kind: "measurement", node: process.version, units, sourceBytes: bytes.length,
    scratchParent, scratchRoot: root,
    filesystem: null,
    method: {
      scope: "One synthetic export invocation in a standalone process. No regression deadline or pass claim.",
      timing: "Export call through returned result. Dynamic import, setup, validation and cleanup excluded.",
      phases: "Copies include source verification, staging and setup until first ZIP-source createReadStream call. ZIP includes final hash and publication until result.",
      overhead: "Real fsync callbacks and read streams wrapped with clocks, counters and passive open/end/error listeners. Overhead is included and unquantified. Callback latency includes queueing and event-loop delay; summed latencies overlap.",
      flushScope: "All callback fsync calls during export, including Node write-stream flush if routed through this builtin. No fsyncSync or fdatasync coverage.",
      zipSources: "Counts stream creation, successful opens, consumed ends and bytesRead for staged STL paths. Does not count individual read syscalls.",
    },
    export: null, flush: null, zipSources: null, validation: null,
    cleanup: { removed: false, error: null }, error: null,
  };
  try {
    const stat = fs.statfsSync(root);
    report.filesystem = { type: stat.type, typeHex: `0x${stat.type.toString(16)}`, blockSize: stat.bsize };
    const input = fixture(root, units);
    const measurement = instrument(root);
    report.flush = measurement.flush;
    report.zipSources = measurement.zipSources;
    let result: ExportResult;
    try {
      const { materializeAcceptedStlBundle } = await import("../apps/server/src/services/export-stl-pack.js");
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      result = await materializeAcceptedStlBundle(input);
      const end = performance.now();
      const cpu = process.cpuUsage(cpuStart);
      const zipStart = measurement.firstZipSourceAt();
      report.export = {
        resultKind: result.kind, elapsedMs: end - start,
        cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
        copiesUntilFirstZipSourceMs: zipStart === null ? null : zipStart - start,
        firstZipSourceUntilResultMs: zipStart === null ? null : end - zipStart,
      };
    } finally {
      measurement.restore();
    }
    report.validation = validate(root, result, units);
    assert.equal(measurement.flush.calls, units + 2, "Expected real source, copy and ZIP flush calls");
    assert.equal(measurement.flush.callbacks, measurement.flush.calls);
    assert.equal(measurement.flush.errors + measurement.flush.synchronousThrows, 0);
    assert.equal(measurement.flush.inflight, 0);
    assert.deepEqual(measurement.zipSources, {
      created: units, opened: units, ended: units, errors: 0, bytesRead: units * bytes.length,
    });
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      report.cleanup.removed = !fs.existsSync(root);
      assert(report.cleanup.removed, "Scratch root still exists");
    } catch (error) {
      report.cleanup.error = String(error);
      process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

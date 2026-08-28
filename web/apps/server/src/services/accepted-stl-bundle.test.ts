import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptedExportPart,
  AcceptedOperationalExport,
  CaptureAcceptedOperationalExportResult,
} from "./accepted-operational-export.js";
import {
  materializeAcceptedStlBundle,
  type AcceptedStlBundleWarning,
  parseStlPackUnitTokens,
  STL_PACK_MAX_SELECTED_UNITS,
} from "./export-stl-pack.js";

const acceptedArtifactTestHook = vi.hoisted(() => ({
  afterVerifiedOpen: undefined as (() => void) | undefined,
  leaseSize: undefined as number | undefined,
}));

vi.mock("./accepted-artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accepted-artifacts.js")>();
  return {
    ...actual,
    openVerifiedAcceptedArtifact(
      input: Parameters<typeof actual.openVerifiedAcceptedArtifact>[0],
    ) {
      const result = actual.openVerifiedAcceptedArtifact(input);
      const hook = acceptedArtifactTestHook.afterVerifiedOpen;
      acceptedArtifactTestHook.afterVerifiedOpen = undefined;
      hook?.();
      if (result.kind === "verified" && acceptedArtifactTestHook.leaseSize != null) {
        return {
          ...result,
          lease: { ...result.lease, size: acceptedArtifactTestHook.leaseSize },
        };
      }
      return result;
    },
  };
});

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "print-partner-accepted-stl-"));
  roots.push(root);
  const reposDir = join(root, "repos");
  const snapshotRoot = join(reposDir, "snapshots", "one");
  const tenantExportsDir = join(root, "exports");
  mkdirSync(snapshotRoot, { recursive: true });
  return { reposDir, snapshotRoot, tenantExportsDir };
}

/** A Required-unit token in the real `ppu_<32 hex>` spelling, stable per unit. */
function unitToken(revisionPartId: number, unitIndex: number): string {
  const digest = createHash("sha256").update(`unit:${revisionPartId}:${unitIndex}`).digest("hex");
  return `ppu_${digest.slice(0, 32)}`;
}

/**
 * Recomputes the publication key the way the service did before per-unit
 * exports existed, from the published bytes alone. A drift here means an
 * already-published bundle would be re-exported under a new path.
 */
function keyBeforeUnitTokens(
  rootPath: string,
  warnings: readonly AcceptedStlBundleWarning[],
): string {
  const files: Array<{ relativePath: string; size: number; sha256: string }> = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path, `${prefix}${entry.name}/`);
        continue;
      }
      const bytes = readFileSync(path);
      files.push({
        relativePath: `${prefix}${entry.name}`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  walk(rootPath, "");
  const identity = {
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    warnings: warnings
      .map((warning) => ({
        code: warning.code,
        relativePath: warning.relativePath,
        sourceLayer: warning.sourceLayer,
      }))
      .sort((left, right) =>
        `${left.relativePath}\0${left.sourceLayer}`.localeCompare(
          `${right.relativePath}\0${right.sourceLayer}`,
        ),
      ),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function part(input: {
  snapshotRoot: string;
  bytes?: Buffer;
  revisionPartId?: number;
  filename?: string;
  relativePath?: string;
  completed?: readonly boolean[];
  unavailable?: boolean;
}): AcceptedExportPart {
  const bytes = input.bytes ?? Buffer.from("accepted-stl");
  const revisionPartId = input.revisionPartId ?? 31;
  const filename = input.filename ?? "widget.stl";
  const relativePath = input.relativePath ?? filename;
  if (!input.unavailable) {
    const path = join(input.snapshotRoot, ...relativePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const completed = input.completed ?? [false, true];
  return {
    revisionPartId,
    projectionPartId: revisionPartId + 100,
    partKey: `part:${revisionPartId}`,
    relativePath,
    filename,
    sourceLayer: "base:Fixture",
    status: "ok",
    role: "accent",
    filamentColorId: null,
    filamentCustomHex: null,
    spoolmanSpoolId: null,
    quantityInferred: completed.length,
    quantityOverride: null,
    quantityEffective: completed.length,
    included: true,
    notes: "",
    geometrySame: null,
    requirement: null,
    optionGroupId: null,
    manifestSource: null,
    artifact: input.unavailable
      ? { kind: "unavailable", reason: "legacy" }
      : {
          kind: "tracked",
          sourceId: 1,
          sourceRevisionId: 2,
          snapshotRoot: input.snapshotRoot,
          relativePath,
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        },
    units: completed.map((value, unitIndex) => ({
      token: unitToken(revisionPartId, unitIndex),
      unitIndex,
      completed: value,
      assembled: false,
    })),
  };
}

function capture(parts: readonly AcceptedExportPart[]): Extract<
  CaptureAcceptedOperationalExportResult,
  { readonly kind: "ready" }
> {
  const accepted: AcceptedOperationalExport = {
    basis: {
      profileId: 7,
      planVersion: 4,
      revisionId: 19,
      revisionDigest: "a".repeat(64),
      requiredUnitMappingDigest: "b".repeat(64),
    },
    profile: {
      id: 7,
      name: "Accepted Build",
      orderNumber: null,
      specialRequest: null,
      archivedAt: null,
    },
    provenance: { kind: "legacy" },
    parts,
  };
  return { kind: "ready", export: accepted };
}

afterEach(() => {
  acceptedArtifactTestHook.afterVerifiedOpen = undefined;
  acceptedArtifactTestHook.leaseSize = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("materializeAcceptedStlBundle", () => {
  it("exports one byte-identical file per selected accepted Required unit", async () => {
    const fixturePaths = fixture();
    const bytes = Buffer.from("verified descriptor bytes");
    const captured = capture([
      part({ snapshotRoot: fixturePaths.snapshotRoot, bytes, completed: [true, false] }),
    ]);

    const all = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "all",
      groupBy: "color_dir",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });
    expect(all.kind).toBe("materialized");
    if (all.kind !== "materialized") return;
    expect(readFileSync(join(all.rootPath, "accent", "_root", "widget_01.stl"))).toEqual(bytes);
    expect(readFileSync(join(all.rootPath, "accent", "_root", "widget_02.stl"))).toEqual(bytes);
    expect(new AdmZip(all.bundlePath ?? "").getEntries().map((entry) => entry.entryName)).toEqual([
      "accent/_root/widget_01.stl",
      "accent/_root/widget_02.stl",
    ]);

    const missing = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "missing",
      groupBy: "color_dir",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });
    expect(missing.kind).toBe("materialized");
    if (missing.kind !== "materialized") return;
    expect(readFileSync(join(missing.rootPath, "accent", "_root", "widget_02.stl"))).toEqual(bytes);
    expect(missing.fileCounts).toEqual({ accent: 1 });
  });

  it("warns once for an unavailable Part while publishing verified peers", async () => {
    const fixturePaths = fixture();
    const captured = capture([
      part({ snapshotRoot: fixturePaths.snapshotRoot, revisionPartId: 31, unavailable: true }),
      part({ snapshotRoot: fixturePaths.snapshotRoot, revisionPartId: 32, filename: "peer.stl" }),
    ]);

    const result = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });

    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;
    expect(result.fileCounts).toEqual({ accent: 2 });
    expect(result.warnings).toEqual([
      {
        code: "artifact_unavailable",
        relativePath: "widget.stl",
        sourceLayer: "base:Fixture",
      },
    ]);
  });

  it("does not publish bytes changed in place after accepted verification", async () => {
    const fixturePaths = fixture();
    const race = part({
      snapshotRoot: fixturePaths.snapshotRoot,
      revisionPartId: 31,
      filename: "race.stl",
      completed: [false],
    });
    const peerBytes = Buffer.from("stable peer");
    const peer = part({
      snapshotRoot: fixturePaths.snapshotRoot,
      revisionPartId: 32,
      filename: "peer.stl",
      bytes: peerBytes,
      completed: [false],
    });
    acceptedArtifactTestHook.afterVerifiedOpen = () => {
      writeFileSync(join(fixturePaths.snapshotRoot, "race.stl"), Buffer.alloc(0));
    };

    const result = await materializeAcceptedStlBundle({
      capture: capture([race, peer]),
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });

    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;
    expect(result.warnings).toEqual([
      {
        code: "artifact_unavailable",
        relativePath: "race.stl",
        sourceLayer: "base:Fixture",
      },
    ]);
    expect(result.fileCounts).toEqual({ accent: 1 });
    expect(readFileSync(join(result.rootPath, "accent", "peer_01.stl"))).toEqual(peerBytes);
  });

  it("publishes a restored artifact beside an earlier partial result", async () => {
    const fixturePaths = fixture();
    const unavailable = part({
      snapshotRoot: fixturePaths.snapshotRoot,
      completed: [false],
      unavailable: true,
    });
    const first = await materializeAcceptedStlBundle({
      capture: capture([unavailable]),
      ...fixturePaths,
      selection: "missing",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });

    const bytes = Buffer.from("restored accepted STL");
    const restored = part({
      snapshotRoot: fixturePaths.snapshotRoot,
      bytes,
      completed: [false],
    });
    const second = await materializeAcceptedStlBundle({
      capture: capture([restored]),
      ...fixturePaths,
      selection: "missing",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });

    expect(first.kind).toBe("materialized");
    expect(second.kind).toBe("materialized");
    if (first.kind !== "materialized" || second.kind !== "materialized") return;
    expect(first.rootPath).not.toBe(second.rootPath);
    expect(first.warnings).toHaveLength(1);
    expect(second.warnings).toEqual([]);
    expect(readFileSync(join(second.rootPath, "accent", "widget_01.stl"))).toEqual(bytes);
  });

  it("publishes changed missing-unit selections beside the prior result", async () => {
    const fixturePaths = fixture();
    const first = await materializeAcceptedStlBundle({
      capture: capture([
        part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false, false] }),
      ]),
      ...fixturePaths,
      selection: "missing",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });
    const second = await materializeAcceptedStlBundle({
      capture: capture([
        part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [true, false] }),
      ]),
      ...fixturePaths,
      selection: "missing",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });

    expect(first.kind).toBe("materialized");
    expect(second.kind).toBe("materialized");
    if (first.kind !== "materialized" || second.kind !== "materialized") return;
    expect(first.rootPath).not.toBe(second.rootPath);
    expect(first.fileCounts).toEqual({ accent: 2 });
    expect(second.fileCounts).toEqual({ accent: 1 });
  });

  it("rejects more than 10,000 selected accepted units before publication", async () => {
    const fixturePaths = fixture();
    const base = part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false] });
    const units = Array.from({ length: 10_001 }, (_, unitIndex) => ({
      token: `31:${unitIndex}`,
      unitIndex,
      completed: false,
      assembled: false,
    }));

    await expect(
      materializeAcceptedStlBundle({
        capture: capture([{ ...base, quantityEffective: units.length, units }]),
        ...fixturePaths,
        selection: "all",
        groupBy: "color_dir",
        roleOrder: ["primary", "accent", "clear", "opaque"],
      }),
    ).resolves.toEqual({ kind: "limit_exceeded" });
  });

  it("counts distinct accepted descriptors even when their digests match", async () => {
    const fixturePaths = fixture();
    const base = part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false] });
    const parts = Array.from({ length: 18 }, (_, index) => ({
      ...base,
      revisionPartId: index + 1,
      projectionPartId: index + 101,
      partKey: `part:${index + 1}`,
      artifact: base.artifact.kind === "tracked"
        ? { ...base.artifact, sourceId: index + 1 }
        : base.artifact,
    }));
    acceptedArtifactTestHook.leaseSize = 15 * 1024 * 1024;

    await expect(
      materializeAcceptedStlBundle({
        capture: capture(parts),
        ...fixturePaths,
        selection: "all",
        groupBy: "color",
        roleOrder: ["primary", "accent", "clear", "opaque"],
      }),
    ).resolves.toEqual({ kind: "limit_exceeded" });
  });

  it("counts the ZIP bytes in the complete published-tree limit", async () => {
    const fixturePaths = fixture();
    const bytes = Buffer.from(Array.from({ length: 80 }, (_, index) => index));

    await expect(
      materializeAcceptedStlBundle({
        capture: capture([
          part({ snapshotRoot: fixturePaths.snapshotRoot, bytes, completed: [false] }),
        ]),
        ...fixturePaths,
        selection: "all",
        groupBy: "color",
        roleOrder: ["primary", "accent", "clear", "opaque"],
        publishedBytesLimit: bytes.length + 16,
      }),
    ).resolves.toEqual({ kind: "limit_exceeded" });
  });

  it("maps publication setup failures to output_failure", async () => {
    const fixturePaths = fixture();
    writeFileSync(fixturePaths.tenantExportsDir, "not a directory");

    await expect(
      materializeAcceptedStlBundle({
        capture: capture([
          part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false] }),
        ]),
        ...fixturePaths,
        selection: "all",
        groupBy: "color",
        roleOrder: ["primary", "accent", "clear", "opaque"],
      }),
    ).resolves.toEqual({ kind: "output_failure" });
  });

  it("keeps a configured traversal role inside the private publication tree", async () => {
    const fixturePaths = fixture();
    const base = part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false] });
    const result = await materializeAcceptedStlBundle({
      capture: capture([{ ...base, role: ".." }]),
      ...fixturePaths,
      selection: "all",
      groupBy: "color_dir",
      roleOrder: [".."],
    });

    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;
    expect(readFileSync(join(result.rootPath, "_root", "_root", "widget_01.stl"))).toEqual(
      Buffer.from("accepted-stl"),
    );
    expect(() => readFileSync(join(result.rootPath, "..", "widget_01.stl"))).toThrow();
  });

  it("exports only the Required units named by unitTokens", async () => {
    const fixturePaths = fixture();
    const bytes = Buffer.from("named unit bytes");
    const captured = capture([
      part({
        snapshotRoot: fixturePaths.snapshotRoot,
        bytes,
        completed: [false, false, false],
      }),
    ]);

    const result = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
      unitTokens: [unitToken(31, 0), unitToken(31, 2)],
    });

    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;
    expect(result.fileCounts).toEqual({ accent: 2 });
    expect(new AdmZip(result.bundlePath ?? "").getEntries().map((entry) => entry.entryName)).toEqual([
      "accent/widget_01.stl",
      "accent/widget_03.stl",
    ]);
    expect(readFileSync(join(result.rootPath, "accent", "widget_01.stl"))).toEqual(bytes);
    expect(() => readFileSync(join(result.rootPath, "accent", "widget_02.stl"))).toThrow();
  });

  it("narrows named Required units further when only missing ones are wanted", async () => {
    const fixturePaths = fixture();
    const captured = capture([
      part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false, true, false] }),
    ]);

    const result = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "missing",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
      unitTokens: [unitToken(31, 1), unitToken(31, 2)],
    });

    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;
    expect(result.fileCounts).toEqual({ accent: 1 });
    expect(() => readFileSync(join(result.rootPath, "accent", "widget_03.stl"))).not.toThrow();
  });

  it("drops tokens the accepted revision does not hold and keeps the rest", async () => {
    const fixturePaths = fixture();
    const captured = capture([
      part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false, false] }),
    ]);

    const result = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
      unitTokens: [unitToken(31, 1), `ppu_${"f".repeat(32)}`],
    });

    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;
    expect(result.fileCounts).toEqual({ accent: 1 });
    expect(() => readFileSync(join(result.rootPath, "accent", "widget_02.stl"))).not.toThrow();
  });

  it("refuses an export whose Required units are all unknown", async () => {
    const fixturePaths = fixture();

    await expect(
      materializeAcceptedStlBundle({
        capture: capture([
          part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false, false] }),
        ]),
        ...fixturePaths,
        selection: "all",
        groupBy: "color",
        roleOrder: ["primary", "accent", "clear", "opaque"],
        unitTokens: [`ppu_${"a".repeat(32)}`, `ppu_${"b".repeat(32)}`],
      }),
    ).resolves.toEqual({ kind: "unknown_unit_tokens" });
  });

  it("publishes two unit selections that share a file list under separate keys", async () => {
    const fixturePaths = fixture();
    const unavailable = () =>
      capture([
        part({
          snapshotRoot: fixturePaths.snapshotRoot,
          completed: [false, false],
          unavailable: true,
        }),
      ]);

    const first = await materializeAcceptedStlBundle({
      capture: unavailable(),
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
      unitTokens: [unitToken(31, 0)],
    });
    const second = await materializeAcceptedStlBundle({
      capture: unavailable(),
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
      unitTokens: [unitToken(31, 1)],
    });

    expect(first.kind).toBe("materialized");
    expect(second.kind).toBe("materialized");
    if (first.kind !== "materialized" || second.kind !== "materialized") return;
    // Same warning, same empty file list. Only the named units tell them apart.
    expect(first.warnings).toEqual(second.warnings);
    expect(first.fileCounts).toEqual({});
    expect(first.rootPath).not.toBe(second.rootPath);
  });

  it("keeps the publication key it published under before unitTokens existed", async () => {
    const fixturePaths = fixture();
    const captured = capture([
      part({ snapshotRoot: fixturePaths.snapshotRoot, completed: [false, true] }),
    ]);

    const result = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
    });
    const empty = await materializeAcceptedStlBundle({
      capture: captured,
      ...fixturePaths,
      selection: "all",
      groupBy: "color",
      roleOrder: ["primary", "accent", "clear", "opaque"],
      unitTokens: [],
    });

    expect(result.kind).toBe("materialized");
    expect(empty.kind).toBe("materialized");
    if (result.kind !== "materialized" || empty.kind !== "materialized") return;
    expect(basename(result.rootPath)).toBe(
      `content-${keyBeforeUnitTokens(result.rootPath, result.warnings)}`,
    );
    expect(empty.rootPath).toBe(result.rootPath);
  });
});

describe("parseStlPackUnitTokens", () => {
  it("accepts an absent field and a list of Required-unit tokens", () => {
    expect(parseStlPackUnitTokens(undefined)).toEqual([]);
    expect(parseStlPackUnitTokens(null)).toEqual([]);
    expect(parseStlPackUnitTokens([])).toEqual([]);
    const token = unitToken(31, 0);
    expect(parseStlPackUnitTokens([token])).toEqual([token]);
  });

  it("refuses anything that is not a bounded list of tokens", () => {
    expect(parseStlPackUnitTokens("ppu_" + "a".repeat(32))).toBe("invalid");
    expect(parseStlPackUnitTokens([42])).toBe("invalid");
    expect(parseStlPackUnitTokens(["31:0"])).toBe("invalid");
    expect(parseStlPackUnitTokens([`ppu_${"A".repeat(32)}`])).toBe("invalid");
    expect(
      parseStlPackUnitTokens(
        Array.from({ length: STL_PACK_MAX_SELECTED_UNITS + 1 }, () => unitToken(31, 0)),
      ),
    ).toBe("invalid");
  });
});

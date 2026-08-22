import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptedExportPart,
  AcceptedOperationalExport,
  CaptureAcceptedOperationalExportResult,
} from "./accepted-operational-export.js";
import { materializeAcceptedStlBundle } from "./export-stl-pack.js";

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
      token: `${revisionPartId}:${unitIndex}`,
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
});

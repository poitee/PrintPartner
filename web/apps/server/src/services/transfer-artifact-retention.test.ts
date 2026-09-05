import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sweepExpiredTransferArtifacts,
  TRANSFER_ARTIFACT_TTL_MS,
} from "./transfer-artifact-retention.js";

describe("transfer artifact retention", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function artifact(root: string, tenant: string, kind: string, id: string): string {
    const directory = join(root, tenant, kind, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "plate.gcode"), "G1 X1");
    return directory;
  }

  it("removes expired handoffs and orphan uploads but preserves live and queued artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-transfer-retention-"));
    roots.push(root);
    const oldHandoff = artifact(root, "tenant-default", "bambu-connect", "old-handoff");
    const freshHandoff = artifact(root, "tenant-default", "bambu-connect", "fresh-handoff");
    const orphanUpload = artifact(root, "tenant-default", "printer-uploads", "orphan");
    const queuedUpload = artifact(root, "tenant-default", "printer-uploads", "queued");
    const now = Date.UTC(2026, 8, 4, 16, 0, 0);
    const old = new Date(now - TRANSFER_ARTIFACT_TTL_MS - 1);
    for (const directory of [oldHandoff, orphanUpload, queuedUpload]) {
      utimesSync(directory, old, old);
    }

    const removed = sweepExpiredTransferArtifacts(root, {
      now,
      protectedDirectories: new Set([queuedUpload]),
    });

    expect(removed.sort()).toEqual([resolve(oldHandoff), resolve(orphanUpload)].sort());
    expect(existsSync(oldHandoff)).toBe(false);
    expect(existsSync(orphanUpload)).toBe(false);
    expect(existsSync(freshHandoff)).toBe(true);
    expect(existsSync(queuedUpload)).toBe(true);
  });

  it("also sweeps legacy transfer directories directly under the exports root", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-transfer-retention-"));
    roots.push(root);
    const legacy = artifact(root, "", "bambu-connect", "legacy");
    const now = Date.UTC(2026, 8, 4, 16, 0, 0);
    const old = new Date(now - TRANSFER_ARTIFACT_TTL_MS - 1);
    utimesSync(legacy, old, old);

    expect(sweepExpiredTransferArtifacts(root, { now })).toEqual([resolve(legacy)]);
    expect(existsSync(legacy)).toBe(false);
  });
});

import { acceptPlanForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptedPlanBasis } from "./db/accepted-plan-progress.js";
import { liveAssignmentFrom, resolveFilamentAssignment } from "./db/accepted-part-filament.js";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";

describe("assignAcceptedFilament spoolman_spool_id", () => {
  it("updates per-part spool override and clears spool when filament changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-part-spool-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const db = getDb(sqlite);
    const repo = new AppRepository(db, undefined, sqlite.reposDir);

    const source = repo.createSource({ name: "PartSpoolRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "widget.stl"), "solid widget");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);

    const plan = repo.createProfile("PartSpoolPlan", source.id);
    acceptPlanForTest(repo, plan.id);
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const part = accepted.snapshot.parts[0]!;
    const expected = acceptedPlanBasis(accepted.snapshot);
    const filamentId = "spoolman:test-int:filament:7";
    const spoolRef = "spoolman:test-int:spool:3";
    const overrideRef = "spoolman:test-int:spool:9";

    const assign = (
      current: typeof part,
      patch: { colorId?: string | null; spoolmanSpoolId?: string | null },
    ) =>
      repo.assignAcceptedFilament({
        expected,
        target: { kind: "part", projectionPartId: current.projectionPartId },
        assignment: resolveFilamentAssignment(liveAssignmentFrom(current), patch),
      });

    let result = assign(part, { colorId: filamentId, spoolmanSpoolId: spoolRef });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated" || !result.part) {
      throw new Error("filament assignment did not update");
    }
    expect(result.part.filamentColorId).toBe(filamentId);
    expect(result.part.spoolmanSpoolId).toBe(spoolRef);

    result = assign(result.part, { spoolmanSpoolId: overrideRef });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated" || !result.part) {
      throw new Error("filament assignment did not update");
    }
    expect(result.part.spoolmanSpoolId).toBe(overrideRef);

    result = assign(result.part, { spoolmanSpoolId: null });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated" || !result.part) {
      throw new Error("filament assignment did not update");
    }
    expect(result.part.spoolmanSpoolId).toBeNull();

    result = assign(result.part, { spoolmanSpoolId: spoolRef });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated" || !result.part) {
      throw new Error("filament assignment did not update");
    }
    result = assign(result.part, { colorId: "pla-black" });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated" || !result.part) {
      throw new Error("filament assignment did not update");
    }
    expect(result.part.filamentColorId).toBe("pla-black");
    expect(result.part.spoolmanSpoolId).toBeNull();

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

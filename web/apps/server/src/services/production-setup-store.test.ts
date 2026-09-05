import { describe, expect, it } from "vitest";
import { defaultProductionSetup } from "@print-partner/contracts";
import {
  settingSnapshotsEqual,
  type SettingCompareAndSetInput,
  type SettingSnapshot,
} from "../db/setting-compare-and-set.js";
import {
  copyProductionSetup,
  loadProductionSetup,
  productionSetupSettingKey,
  ProductionSetupWriteConflictError,
  updateProductionSetup,
} from "./production-setup-store.js";

class MemoryProductionSetupRepository {
  readonly compareAndSetExpectations: SettingSnapshot[] = [];

  constructor(readonly values = new Map<string, string>()) {}

  getSetting(key: string, defaultValue: string | null = null): string | null {
    return this.values.get(key) ?? defaultValue;
  }

  setSetting(key: string, value: string): void {
    this.values.set(key, value);
  }

  getSettingSnapshot(key: string): SettingSnapshot {
    const value = this.values.get(key);
    return value === undefined ? { kind: "missing" } : { kind: "stored", value };
  }

  compareAndSetSetting(input: SettingCompareAndSetInput): boolean {
    this.compareAndSetExpectations.push(input.expected);
    const current = this.getSettingSnapshot(input.key);
    if (!settingSnapshotsEqual(current, input.expected)) return false;
    this.values.set(input.key, input.value);
    return true;
  }
}

class ProcessLikeProductionSetupRepository extends MemoryProductionSetupRepository {
  beforeNextCompareAndSet: (() => void) | null = null;

  constructor(values: Map<string, string>) {
    super(values);
  }

  override compareAndSetSetting(input: SettingCompareAndSetInput): boolean {
    const beforeCompareAndSet = this.beforeNextCompareAndSet;
    this.beforeNextCompareAndSet = null;
    beforeCompareAndSet?.();
    return super.compareAndSetSetting(input);
  }
}

class ConflictingProductionSetupRepository extends MemoryProductionSetupRepository {
  override compareAndSetSetting(input: SettingCompareAndSetInput): boolean {
    this.compareAndSetExpectations.push(input.expected);
    return false;
  }
}

class DisappearingProductionSetupRepository extends MemoryProductionSetupRepository {
  override compareAndSetSetting(input: SettingCompareAndSetInput): boolean {
    this.compareAndSetExpectations.push(input.expected);
    this.values.delete(input.key);
    return false;
  }
}

function legacySetup(profileId: number): string {
  return JSON.stringify({
    format: "production-setup-v1",
    profile_id: profileId,
    preferred_slicer_instance_id: "orca-main",
    selection: { mode: "custom", selected_unit_tokens: ["unit:a:1"] },
    rules: [],
    updated_at: "2026-01-01T00:00:00.000Z",
  });
}

describe("production setup store", () => {
  it("normalizes valid legacy records and rejects a mismatched Build", () => {
    const repo = new MemoryProductionSetupRepository();
    repo.values.set(productionSetupSettingKey(7), legacySetup(7));
    repo.values.set(productionSetupSettingKey(8), legacySetup(7));

    expect(loadProductionSetup(repo, 7)).toMatchObject({
      profile_id: 7,
      printer_assignments: [],
      route: null,
    });
    expect(loadProductionSetup(repo, 8)).toEqual(defaultProductionSetup(8));
  });

  it("applies each command to the current record through compare-and-set", () => {
    const repo = new MemoryProductionSetupRepository();
    repo.values.set(productionSetupSettingKey(7), legacySetup(7));

    const withRoute = updateProductionSetup(repo, {
      profileId: 7,
      command: { kind: "set_route", route: "stl" },
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    const withRules = updateProductionSetup(repo, {
      profileId: 7,
      command: {
        kind: "replace_rules",
        rules: [{ id: "by-color", enabled: true, kind: "separate_by", field: "color" }],
      },
      updatedAt: "2026-09-04T00:00:01.000Z",
    });

    expect(withRoute.route).toBe("stl");
    expect(withRules).toMatchObject({
      preferred_slicer_instance_id: "orca-main",
      selection: { mode: "custom", selected_unit_tokens: ["unit:a:1"] },
      route: "stl",
      rules: [{ id: "by-color", enabled: true, kind: "separate_by", field: "color" }],
      updated_at: "2026-09-04T00:00:01.000Z",
    });
    expect(repo.compareAndSetExpectations).toHaveLength(2);
  });

  it("preserves different-field updates from independently serialized actors", () => {
    const values = new Map<string, string>();
    const firstActor = new ProcessLikeProductionSetupRepository(values);
    const secondActor = new ProcessLikeProductionSetupRepository(values);
    values.set(productionSetupSettingKey(7), legacySetup(7));
    firstActor.beforeNextCompareAndSet = () => {
      updateProductionSetup(secondActor, {
        profileId: 7,
        command: { kind: "set_route", route: "stl" },
        updatedAt: "2026-09-04T00:00:01.000Z",
      });
    };

    updateProductionSetup(firstActor, {
      profileId: 7,
      command: {
        kind: "replace_rules",
        rules: [{ id: "by-color", enabled: true, kind: "separate_by", field: "color" }],
      },
      updatedAt: "2026-09-04T00:00:02.000Z",
    });

    expect(loadProductionSetup(firstActor, 7)).toMatchObject({
      route: "stl",
      rules: [{ id: "by-color", enabled: true, kind: "separate_by", field: "color" }],
    });
  });

  it("reports sustained contention after bounded retries", () => {
    const repo = new ConflictingProductionSetupRepository();

    expect(() => updateProductionSetup(repo, {
      profileId: 7,
      command: { kind: "set_route", route: "stl" },
      updatedAt: "2026-09-04T00:00:00.000Z",
    })).toThrow(ProductionSetupWriteConflictError);
    expect(repo.compareAndSetExpectations).toHaveLength(8);
  });

  it("does not recreate a setting that disappears after a stored snapshot", () => {
    const repo = new DisappearingProductionSetupRepository();
    repo.values.set(productionSetupSettingKey(7), legacySetup(7));

    expect(() => updateProductionSetup(repo, {
      profileId: 7,
      command: { kind: "set_route", route: "stl" },
      updatedAt: "2026-09-04T00:00:00.000Z",
    })).toThrow(ProductionSetupWriteConflictError);
    expect(repo.compareAndSetExpectations).toHaveLength(1);
    expect(repo.values.has(productionSetupSettingKey(7))).toBe(false);
  });

  it("copies only a valid setup and writes its canonical defaults", () => {
    const repo = new MemoryProductionSetupRepository();
    repo.values.set(productionSetupSettingKey(7), legacySetup(7));

    copyProductionSetup(repo, {
      sourceProfileId: 7,
      targetProfileId: 9,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });

    expect(loadProductionSetup(repo, 9)).toMatchObject({
      profile_id: 9,
      preferred_slicer_instance_id: "orca-main",
      printer_assignments: [],
      route: null,
      updated_at: "2026-09-04T00:00:00.000Z",
    });

    repo.values.set(productionSetupSettingKey(10), "not json");
    copyProductionSetup(repo, {
      sourceProfileId: 10,
      targetProfileId: 11,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    expect(repo.values.has(productionSetupSettingKey(11))).toBe(false);
  });
});

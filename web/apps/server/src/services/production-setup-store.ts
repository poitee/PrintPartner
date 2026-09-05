import {
  defaultProductionSetup,
  productionSetupSchema,
  type ProductionSetup,
  type ProductionSetupCommand,
} from "@print-partner/contracts";
import type {
  SettingCompareAndSetInput,
  SettingSnapshot,
} from "../db/setting-compare-and-set.js";

type ProductionSetupReader = Readonly<{
  getSetting(key: string, defaultValue?: string | null): string | null;
}>;

type ProductionSetupWriter = ProductionSetupReader & Readonly<{
  setSetting(key: string, value: string): void;
}>;

type ProductionSetupRepository = Readonly<{
  getSettingSnapshot(key: string): SettingSnapshot;
  compareAndSetSetting(input: SettingCompareAndSetInput): boolean;
}>;

const MAX_UPDATE_ATTEMPTS = 8;

export class ProductionSetupWriteConflictError extends Error {
  override readonly name = "ProductionSetupWriteConflictError";
}

export function productionSetupSettingKey(profileId: number): string {
  return `production_setup:${profileId}`;
}

export function parseStoredProductionSetup(
  raw: string | null | undefined,
  profileId: number,
): ProductionSetup | null {
  if (!raw) return null;
  try {
    const parsed = productionSetupSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.profile_id === profileId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function loadProductionSetup(
  repo: ProductionSetupReader,
  profileId: number,
): ProductionSetup {
  return parseStoredProductionSetup(
    repo.getSetting(productionSetupSettingKey(profileId)),
    profileId,
  ) ?? defaultProductionSetup(profileId);
}

function applyProductionSetupCommand(
  setup: ProductionSetup,
  command: ProductionSetupCommand,
): ProductionSetup {
  switch (command.kind) {
    case "set_preferred_slicer_instance":
      return {
        ...setup,
        preferred_slicer_instance_id: command.preferred_slicer_instance_id,
      };
    case "set_selection":
      return { ...setup, selection: command.selection };
    case "replace_printer_assignments":
      return { ...setup, printer_assignments: command.printer_assignments };
    case "set_route":
      return { ...setup, route: command.route };
    case "replace_rules":
      return { ...setup, rules: command.rules };
  }
  return unsupportedProductionSetupCommand(command);
}

function unsupportedProductionSetupCommand(command: never): never {
  throw new Error(`Unsupported production setup command: ${String(command)}`);
}

export function updateProductionSetup(
  repo: ProductionSetupRepository,
  input: Readonly<{
    profileId: number;
    command: ProductionSetupCommand;
    updatedAt: string;
  }>,
): ProductionSetup {
  const key = productionSetupSettingKey(input.profileId);
  let lastFailedExpectation: SettingSnapshot | null = null;
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const expected = repo.getSettingSnapshot(key);
    if (lastFailedExpectation?.kind === "stored" && expected.kind === "missing") {
      break;
    }
    const current = parseStoredProductionSetup(
      expected.kind === "stored" ? expected.value : null,
      input.profileId,
    )
      ?? defaultProductionSetup(input.profileId);
    const setup = productionSetupSchema.parse({
      ...applyProductionSetupCommand(current, input.command),
      format: "production-setup-v1",
      profile_id: input.profileId,
      updated_at: input.updatedAt,
    });
    if (repo.compareAndSetSetting({
      key,
      expected,
      value: JSON.stringify(setup),
    })) {
      return setup;
    }
    lastFailedExpectation = expected;
  }
  throw new ProductionSetupWriteConflictError(
    "Production setup changed too often; retry the command",
  );
}

export function copyProductionSetup(
  repo: ProductionSetupWriter,
  input: Readonly<{
    sourceProfileId: number;
    targetProfileId: number;
    updatedAt: string;
  }>,
): void {
  const source = parseStoredProductionSetup(
    repo.getSetting(productionSetupSettingKey(input.sourceProfileId)),
    input.sourceProfileId,
  );
  if (!source) return;

  const copy = productionSetupSchema.parse({
    ...source,
    profile_id: input.targetProfileId,
    updated_at: input.updatedAt,
  });
  repo.setSetting(productionSetupSettingKey(input.targetProfileId), JSON.stringify(copy));
}

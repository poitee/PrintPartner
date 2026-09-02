import {
  EXTERNAL_ACCESS_DEFAULT,
  isExternalAccessMode,
  type ExternalAccessMode,
  type ExternalAccessSettings,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

const SETTING_KEY = "external_access_mode";

export function readExternalAccessSettings(
  repository: AppRepository,
): ExternalAccessSettings {
  const stored = repository.getSetting(SETTING_KEY);
  return {
    mode: isExternalAccessMode(stored) ? stored : EXTERNAL_ACCESS_DEFAULT,
  };
}

export function saveExternalAccessMode(
  repository: AppRepository,
  mode: ExternalAccessMode,
): ExternalAccessSettings {
  repository.setSetting(SETTING_KEY, mode);
  return { mode };
}

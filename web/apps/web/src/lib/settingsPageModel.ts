import {
  canUseRecoveryTools,
  canUseSettingsResource,
  resolveSettingsResourceDisplay,
  type EngineState,
  type SettingsResourceDisplay,
} from "./workflowState";

export type SettingsResource = "filaments" | "githubPat" | "sourceUpdates" | "discord";

export type SettingsResourceLoad = {
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

export type SettingsResourceSummary = {
  ready: Record<SettingsResource, boolean>;
  display: Record<SettingsResource, SettingsResourceDisplay>;
  recoveryToolsReady: boolean;
};

export const SOURCE_UPDATE_INTERVAL_OPTIONS = [
  { value: "0", label: "Off (manual only)" },
  { value: "1", label: "Every hour" },
  { value: "6", label: "Every 6 hours" },
  { value: "24", label: "Every 24 hours" },
  { value: "168", label: "Weekly" },
] as const;

export const INITIAL_RESOURCE_LOAD: SettingsResourceLoad = {
  loading: false,
  loaded: false,
  error: null,
};

export const INITIAL_SETTINGS_LOADS: Record<SettingsResource, SettingsResourceLoad> = {
  filaments: INITIAL_RESOURCE_LOAD,
  githubPat: INITIAL_RESOURCE_LOAD,
  sourceUpdates: INITIAL_RESOURCE_LOAD,
  discord: INITIAL_RESOURCE_LOAD,
};

const SETTINGS_RESOURCES: readonly SettingsResource[] = [
  "filaments",
  "githubPat",
  "sourceUpdates",
  "discord",
];

export function settingsResourceSummary(
  engineState: EngineState,
  loads: Record<SettingsResource, SettingsResourceLoad>,
): SettingsResourceSummary {
  const ready = {} as Record<SettingsResource, boolean>;
  const display = {} as Record<SettingsResource, SettingsResourceDisplay>;

  for (const resource of SETTINGS_RESOURCES) {
    const load = loads[resource];
    const resourceState = {
      loading: load.loading,
      error: load.error,
      hasData: load.loaded,
    };
    ready[resource] = canUseSettingsResource(engineState, resourceState);
    display[resource] = resolveSettingsResourceDisplay(resourceState);
  }

  return {
    ready,
    display,
    recoveryToolsReady: canUseRecoveryTools(engineState),
  };
}

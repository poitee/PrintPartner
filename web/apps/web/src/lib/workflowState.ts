export type EngineState = "loading" | "offline" | "ready";
export type ResourceState = "loading" | "error" | "ready";
export type SettingsResourceDisplay =
  | "loading"
  | "initial-error"
  | "background-error"
  | "ready";

type EngineStateInput = {
  health: { ok: boolean } | null;
  loading: boolean;
  error: string | null;
};

type ResourceStateInput = {
  loading: boolean;
  error: string | null;
  hasData: boolean;
};

export function resolveEngineState(input: EngineStateInput): EngineState {
  if (input.health?.ok) return "ready";
  if (input.health || input.error || !input.loading) return "offline";
  return "loading";
}

export function resolveResourceState(input: ResourceStateInput): ResourceState {
  if (input.hasData) return "ready";
  if (input.error) return "error";
  return input.loading ? "loading" : "ready";
}

export function getBackgroundError(error: string | null, hasData: boolean): string | null {
  return hasData ? error : null;
}

export function resolveSettingsResourceDisplay(
  resource: ResourceStateInput,
): SettingsResourceDisplay {
  if (resource.hasData) return resource.error ? "background-error" : "ready";
  if (resource.error) return "initial-error";
  return resource.loading ? "loading" : "ready";
}

export function canUseSettingsResource(
  engineState: EngineState,
  resource: ResourceStateInput,
): boolean {
  return engineState === "ready" && resolveResourceState(resource) === "ready";
}

export function canUseRecoveryTools(engineState: EngineState): boolean {
  return engineState === "ready";
}

export function shouldMountPlanTools(
  engineState: EngineState,
  selectedProfileId: number | null,
): boolean {
  return engineState === "ready" && selectedProfileId != null;
}

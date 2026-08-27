import type { EngineState, ResourceState } from "./workflowState";

export function plansLoadingAnnouncement(input: {
  engineState: EngineState;
  profilesState: ResourceState;
}): string {
  if (input.engineState === "loading") return "Connecting to the engine…";
  if (input.profilesState === "loading") return "Loading builds…";
  return "";
}

export function isPlansListEmpty(input: {
  engineState: EngineState;
  profilesState: ResourceState;
  profileCount: number;
  rowCount: number;
}): { emptyAll: boolean; emptyFilter: boolean } {
  return {
    emptyAll:
      input.engineState === "ready" &&
      input.profilesState === "ready" &&
      input.profileCount === 0,
    emptyFilter:
      input.profilesState === "ready" && input.profileCount > 0 && input.rowCount === 0,
  };
}

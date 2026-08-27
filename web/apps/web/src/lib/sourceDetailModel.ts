import type {
  StlNamingProfile,
  StlNamingProfileOverride,
} from "@print-partner/contracts";
import { mergeStlNamingProfiles } from "../api/endpoints/stlNaming";

export function sourceNamingDirty(input: {
  useDefaults: boolean;
  savedUseDefaults: boolean;
  overrideDraft: StlNamingProfile;
  globalNaming: StlNamingProfile;
  savedOverride: StlNamingProfileOverride;
}): boolean {
  if (input.useDefaults !== input.savedUseDefaults) return true;
  if (input.useDefaults) return false;
  return (
    JSON.stringify(input.overrideDraft) !==
    JSON.stringify(mergeStlNamingProfiles(input.globalNaming, input.savedOverride))
  );
}

import type {
  SourceNamingResponse,
  StlNamingProfileOverride,
} from "@print-partner/contracts";
import type { StlNamingProfileDict } from "@print-partner/domain";
import { digestEffectiveNaming } from "../services/plan-freshness.js";

export function sourceNamingResponse(input: {
  readonly useDefaults: boolean;
  readonly override: StlNamingProfileOverride;
  readonly effective: StlNamingProfileDict;
}): SourceNamingResponse {
  const common = {
    effective: input.effective,
    effective_digest: digestEffectiveNaming(input.effective),
  };
  return input.useDefaults
    ? { use_defaults: true, override: {}, ...common }
    : { use_defaults: false, override: input.override, ...common };
}

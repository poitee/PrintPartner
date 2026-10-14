import { z } from "zod";
import type { AppRepository } from "../db/repository.js";

const featureTogglesSchema = z.object({
  farm: z.boolean().optional(),
  orders: z.boolean().optional(),
  bambu: z.boolean().optional(),
  spoolman: z.boolean().optional(),
});

export type FarmAccess =
  | { kind: "allowed" }
  | {
      kind: "disabled";
      code: "FEATURE_DISABLED";
      error: "Feature farm is disabled.";
    }
  | {
      kind: "invalid";
      code: "FEATURE_TOGGLES_INVALID";
      error: "Stored feature toggles are invalid.";
    };

export function readFarmAccess(repo: AppRepository): FarmAccess {
  if (process.env.PP_DESKTOP_REBUILD !== "1" && process.env.PP_DESKTOP_REBUILD !== "true") {
    return { kind: "allowed" };
  }
  return resolveFarmAccess(repo.getSettingSnapshot("feature_toggles"));
}

function resolveFarmAccess(snapshot: ReturnType<AppRepository["getSettingSnapshot"]>): FarmAccess {
  if (snapshot.kind === "stored") {
    try {
      const stored: unknown = JSON.parse(snapshot.value);
      const toggles = featureTogglesSchema.parse(stored);
      if (toggles.farm === true) return { kind: "allowed" };
    } catch {
      return {
        kind: "invalid",
        code: "FEATURE_TOGGLES_INVALID",
        error: "Stored feature toggles are invalid.",
      };
    }
  }
  return { kind: "disabled", code: "FEATURE_DISABLED", error: "Feature farm is disabled." };
}

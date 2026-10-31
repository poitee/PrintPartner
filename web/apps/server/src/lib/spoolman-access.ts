import { z } from "zod";
import type { AppRepository } from "../db/repository.js";
import { desktopFeaturesEnabled } from "./feature-toggles.js";
import { readFeatureAccess } from "./feature-access.js";

export function readSpoolmanAccess(repo: AppRepository, profileId?: number) {
  if (
    desktopFeaturesEnabled() &&
    profileId !== undefined &&
    !repo.getOwnedProfileIdentity(profileId)
  ) {
    return { kind: "not_found", code: "PROFILE_NOT_FOUND", error: "Profile not found" } as const;
  }
  return readFeatureAccess(() => repo, "spoolman", profileId);
}

const inventoryScope = z.object({
  profile_id: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .refine(Number.isSafeInteger)
    .optional(),
});

export function readSpoolmanQueryAccess(repo: AppRepository, query: unknown) {
  if (!desktopFeaturesEnabled()) return readSpoolmanAccess(repo);
  const parsed = inventoryScope.safeParse(query);
  if (!parsed.success) {
    return {
      kind: "bad_request",
      code: "INVALID_PROFILE_ID",
      error: "profile_id must be a positive integer",
    } as const;
  }
  return readSpoolmanAccess(repo, parsed.data.profile_id);
}

export function spoolmanAccessProblem(
  access: Exclude<ReturnType<typeof readSpoolmanQueryAccess>, { kind: "allowed" }>,
) {
  const status =
    access.kind === "disabled"
      ? 403
      : access.kind === "invalid"
        ? 500
        : access.kind === "not_found"
          ? 404
          : 400;
  const title =
    status === 403
      ? "Forbidden"
      : status === 500
        ? "Internal Server Error"
        : status === 404
          ? "Not Found"
          : "Bad Request";
  return { status, title, detail: access.error, code: access.code };
}

type FilamentAssignmentFields = {
  filament_color_id?: string | null;
  spoolman_spool_id?: string | null;
};

export function hasSpoolmanAssignment(
  fields: FilamentAssignmentFields,
  previous?: FilamentAssignmentFields,
) {
  return Boolean(
    (fields.filament_color_id?.trim().startsWith("spoolman:") &&
      fields.filament_color_id !== previous?.filament_color_id) ||
    (fields.spoolman_spool_id?.trim() && fields.spoolman_spool_id !== previous?.spoolman_spool_id),
  );
}

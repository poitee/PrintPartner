import {
  DEFAULT_STL_NAMING_PROFILE,
  type StlNamingProfile,
  type StlNamingProfileOverride,
  type StlNamingRoleId,
} from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export type StlNamingPreviewResult = {
  role: StlNamingRoleId;
  quantity: number;
  part_slug: string;
};

export const DEFAULT_QUANTITY_REGEX = DEFAULT_STL_NAMING_PROFILE.quantity.regex;

export function mergeStlNamingProfiles(
  base: StlNamingProfile,
  override: StlNamingProfileOverride | undefined,
): StlNamingProfile {
  if (!override) return base;
  const rolesById = new Map(base.roles.map((role) => [role.id, structuredClone(role)]));
  for (const roleOverride of override.roles ?? []) {
    const current = rolesById.get(roleOverride.id) ?? {
      id: roleOverride.id,
      label: roleOverride.id,
      markers: [],
    };
    rolesById.set(roleOverride.id, {
      id: roleOverride.id,
      label: roleOverride.label ?? current.label,
      markers: roleOverride.markers ?? current.markers,
    });
  }
  return {
    roles: [...rolesById.values()],
    quantity: override.quantity ? { ...base.quantity, ...override.quantity } : base.quantity,
    slug: override.slug ? { ...base.slug, ...override.slug } : base.slug,
    folder_rules: override.folder_rules ?? base.folder_rules,
    export_role_order: override.export_role_order ?? base.export_role_order,
  };
}

export async function fetchStlNaming(): Promise<StlNamingProfile> {
  const body = await engineFetch<{ profile: StlNamingProfile }>("/settings/stl-naming");
  return body.profile;
}

export async function saveStlNaming(profile: StlNamingProfile): Promise<StlNamingProfile> {
  const body = await engineFetch<{ profile: StlNamingProfile }>("/settings/stl-naming", {
    method: "PUT",
    body: JSON.stringify({ profile }),
  });
  return body.profile;
}

export async function previewStlNaming(body: {
  relative_path: string;
  profile?: Partial<StlNamingProfile> | StlNamingProfile;
}): Promise<StlNamingPreviewResult> {
  return engineFetch<StlNamingPreviewResult>("/settings/stl-naming/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

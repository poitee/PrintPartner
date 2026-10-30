import { TENANT_FEATURE_TOGGLES_CAPABILITY } from "@print-partner/contracts";

/**
 * Root attribute set while the rebuilt desktop UI is opted in. Rebuilt styles
 * scope under `:root[data-desktop-rebuild]`, so the default UI is unchanged.
 */
export const DESKTOP_REBUILD_ATTRIBUTE = "data-desktop-rebuild";

/** Health advertises this capability only when `PP_DESKTOP_REBUILD` is exactly `1` or `true`. */
export function desktopRebuildEnabled(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY) === true;
}

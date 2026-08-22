/** Central route builders — keep cross-route links consistent. */

export function withProfile(path: string, profileId: number | null | undefined): string {
  if (profileId == null || profileId <= 0) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}profile=${profileId}`;
}

/** Canonical: Library (sources registry). */
export function libraryRoute(): string {
  return "/library";
}

export function buildSourcesRoute(profileId?: number | null): string {
  return withProfile("/sources", profileId ?? null);
}

export function planRoute(profileId?: number | null): string {
  return withProfile("/plan", profileId ?? null);
}

/** @deprecated Prefer `planRoute`. */
export function partsRoute(profileId?: number | null): string {
  return planRoute(profileId);
}

/** Canonical: Progress (print checkoff). */
export function progressRoute(profileId?: number | null): string {
  return withProfile("/progress", profileId ?? null);
}

export function productionRoute(profileId?: number | null): string {
  return withProfile("/export", profileId ?? null);
}

export function prepareMissingPartsRoute(profileId?: number | null): string {
  const path = productionRoute(profileId);
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}select=missing`;
}

/** @deprecated Prefer `productionRoute`. */
export function exportRoute(profileId?: number | null): string {
  return productionRoute(profileId);
}

export function buildsRoute(profileId?: number | null): string {
  return withProfile("/builds", profileId ?? null);
}

export function plansRoute(profileId?: number | null): string {
  return buildsRoute(profileId);
}

export function settingsRoute(): string {
  return "/settings";
}

/** Settings → Printers section (hash scrolls past About). */
export function settingsPrintersRoute(): string {
  return "/settings#printers";
}

export function printersRoute(): string {
  return "/printers";
}

export function helpRoute(): string {
  return "/help";
}

export function isPrintersPath(pathname: string): boolean {
  return pathname === "/printers";
}

export function sourcesRoute(): string {
  return libraryRoute();
}

/** @deprecated Prefer `buildSourcesRoute`. */
export function buildRoute(profileId?: number | null): string {
  return buildSourcesRoute(profileId);
}

/** @deprecated Prefer `planRoute`. */
export function reviewRoute(profileId?: number | null): string {
  return planRoute(profileId);
}

export function planStudioRoute(planId: number): string {
  return buildSourcesRoute(planId);
}

export function isKitStudioPath(pathname: string): boolean {
  return /^\/plans\/\d+\/studio/.test(pathname);
}

export function isLibraryPath(pathname: string): boolean {
  return pathname === "/library";
}

export function isSourcesPath(pathname: string): boolean {
  return pathname === "/sources" || pathname === "/build";
}

/** @deprecated Prefer `isSourcesPath`. */
export function isBuildPath(pathname: string): boolean {
  return isSourcesPath(pathname);
}

export function isPlanPath(pathname: string): boolean {
  return pathname === "/plan" || pathname === "/parts" || pathname === "/review";
}

export function isBuildsPath(pathname: string): boolean {
  return pathname === "/builds" || pathname === "/plans";
}

export function isPlansPath(pathname: string): boolean {
  return isBuildsPath(pathname);
}

export function isPartsPath(pathname: string): boolean {
  return isPlanPath(pathname);
}

export function isProgressPath(pathname: string): boolean {
  return pathname === "/progress" || pathname === "/checkoff";
}

export function isExportPath(pathname: string): boolean {
  return pathname === "/export";
}

/**
 * Parts or Progress (and legacy `/review` / `/checkoff`).
 * Used by surfaces that treat both as post-plan workflow.
 */
export function isReviewPath(pathname: string): boolean {
  return isPartsPath(pathname) || isProgressPath(pathname);
}

/** @deprecated Prefer `isProgressPath`. */
export function isCheckoffPath(pathname: string): boolean {
  return isProgressPath(pathname);
}

/** Alias for deep links — Progress is the dedicated checkoff stage. */
export function checkoffRoute(profileId?: number | null): string {
  return progressRoute(profileId);
}

export function isPlanWorkflowPath(pathname: string): boolean {
  return (
    isLibraryPath(pathname) ||
    isSourcesPath(pathname) ||
    isPlanPath(pathname) ||
    isBuildsPath(pathname) ||
    isPlansPath(pathname) ||
    isPartsPath(pathname) ||
    isProgressPath(pathname) ||
    isExportPath(pathname) ||
    isKitStudioPath(pathname)
  );
}

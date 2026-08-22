import {
  buildSourcesRoute,
  planRoute,
  printersRoute,
  productionRoute,
  progressRoute,
  settingsRoute,
} from "./routes";

export const GLOBAL_SECTIONS = ["builds", "production", "printers", "settings"] as const;
export type GlobalSection = (typeof GLOBAL_SECTIONS)[number];

export const BUILD_SECTIONS = ["sources", "plan", "checkoff", "production"] as const;
export type BuildSection = (typeof BUILD_SECTIONS)[number];

export function globalSectionPath(section: GlobalSection): string {
  switch (section) {
    case "builds":
      return "/builds";
    case "production":
      return "/production";
    case "printers":
      return printersRoute();
    case "settings":
      return settingsRoute();
  }
}

export function buildSectionPath(
  section: BuildSection,
  profileId?: number | null,
): string {
  switch (section) {
    case "sources":
      return buildSourcesRoute(profileId);
    case "plan":
      return planRoute(profileId);
    case "checkoff":
      return progressRoute(profileId);
    case "production":
      return productionRoute(profileId);
  }
}

export function globalSectionFromPath(pathname: string): GlobalSection | null {
  if (pathname === "/builds" || pathname === "/plans" || pathname === "/") return "builds";
  if (pathname === "/production") return "production";
  if (pathname === "/printers") return "printers";
  if (pathname === "/settings") return "settings";
  return null;
}

export function buildSectionFromPath(pathname: string): BuildSection | null {
  if (pathname === "/sources" || pathname === "/build") return "sources";
  if (pathname === "/plan" || pathname === "/parts" || pathname === "/review") return "plan";
  if (pathname === "/progress" || pathname === "/checkoff") return "checkoff";
  if (pathname === "/export") return "production";
  return null;
}

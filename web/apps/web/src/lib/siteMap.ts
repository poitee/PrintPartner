import {
  printersRoute,
  settingsRoute,
} from "./routes";

export const GLOBAL_SECTIONS = ["builds", "production", "printers", "settings"] as const;
type GlobalSection = (typeof GLOBAL_SECTIONS)[number];

export const BUILD_SECTIONS = ["sources", "plan", "production", "checkoff"] as const;

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

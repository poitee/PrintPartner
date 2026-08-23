import { globalSectionPath } from "./siteMap";
import {
  buildsRoute,
  helpRoute,
  libraryRoute,
  printersRoute,
  settingsRoute,
} from "./routes";

export type SpineUtilityId =
  | "builds"
  | "library"
  | "production"
  | "printers"
  | "settings"
  | "help";

export type SpineUtilityNavItem = {
  id: SpineUtilityId;
  to: string;
  label: string;
  path: string;
};

export function spineUtilityNavItems(
  profileId?: number | null,
): SpineUtilityNavItem[] {
  return [
    { id: "builds", to: buildsRoute(profileId), label: "Builds", path: "/builds" },
    {
      id: "library",
      to: libraryRoute(),
      label: "Source Library",
      path: "/library",
    },
    {
      id: "production",
      to: globalSectionPath("production"),
      label: "All Production",
      path: "/production",
    },
    { id: "printers", to: printersRoute(), label: "Printers", path: "/printers" },
    { id: "settings", to: settingsRoute(), label: "Settings", path: "/settings" },
    { id: "help", to: helpRoute(), label: "Help", path: "/help" },
  ];
}

import { globalSectionPath } from "./siteMap";
import {
  buildsRoute,
  helpRoute,
  printersRoute,
  settingsRoute,
} from "./routes";

export type SpineUtilityId = "builds" | "production" | "printers" | "settings" | "help";

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
      id: "production",
      to: globalSectionPath("production"),
      label: "Production",
      path: "/production",
    },
    { id: "printers", to: printersRoute(), label: "Printers", path: "/printers" },
    { id: "settings", to: settingsRoute(), label: "Settings", path: "/settings" },
    { id: "help", to: helpRoute(), label: "Help", path: "/help" },
  ];
}

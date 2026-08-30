import { type MouseEvent, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  BookOpen,
  Factory,
  Layers,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  Settings,
} from "lucide-react";
import CreatePlanButton from "../CreatePlanButton";
import PlanPicker from "../PlanPicker";
import SupportCta from "../SupportCta";
import WorkflowProgress from "../WorkflowProgress";
import LayeredSheetMark from "./BrandMark";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  spineUtilityNavItems,
  type SpineUtilityId,
  type SpineUtilityNavItem,
} from "../../lib/spineUtilityNav";
import { cn } from "@/lib/utils";
import type { WorkflowStage, WorkflowStageId } from "../../lib/workflowStages";
import { useProfileSelection } from "../../context/ProfileContext";

type Props = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  stages: WorkflowStage[];
  activeId: WorkflowStageId | null;
  onStageNavigate: (to: string, e: MouseEvent<HTMLAnchorElement>) => void;
};

const UTILITY_ICONS: Record<
  SpineUtilityId,
  typeof Layers
> = {
  builds: Layers,
  library: Library,
  production: Factory,
  printers: Printer,
  settings: Settings,
  help: BookOpen,
};

/* The six utility destinations render as two sidebar groups: workshop-wide
   pages in the body, support pages in the footer. The item list itself stays
   flat and ordered in spineUtilityNav.ts (locked by siteChromeLabels tests). */
const WORKSHOP_IDS: SpineUtilityId[] = ["builds", "library", "production", "printers"];

const NAV_RAIL =
  "relative before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:content-['']";
const NAV_ACTIVE = "bg-primary/12 font-semibold text-primary before:bg-primary";
const NAV_IDLE =
  "text-muted-foreground hover:bg-accent/70 hover:text-foreground before:bg-transparent";

function SidebarTooltip({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: ReactNode;
}) {
  if (!collapsed) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function GroupHeading({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  if (collapsed) return <Separator className="mx-1 w-auto" />;
  return (
    <p className="px-1 font-mono text-3xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

function UtilityLink({
  link,
  collapsed,
  onStageNavigate,
}: {
  link: SpineUtilityNavItem & { icon: typeof Layers; match: boolean };
  collapsed: boolean;
  onStageNavigate: Props["onStageNavigate"];
}) {
  if (collapsed) {
    return (
      <SidebarTooltip label={link.label} collapsed>
        <NavLink
          to={link.to}
          onClick={(e) => onStageNavigate(link.to, e)}
          className={cn(
            NAV_RAIL,
            "flex items-center justify-center rounded-md p-2.5 transition-colors",
            link.match ? NAV_ACTIVE : NAV_IDLE,
          )}
          aria-label={link.label}
        >
          <link.icon className="h-4 w-4" />
        </NavLink>
      </SidebarTooltip>
    );
  }
  return (
    <NavLink
      to={link.to}
      onClick={(e) => onStageNavigate(link.to, e)}
      className={cn(
        NAV_RAIL,
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
        link.match ? NAV_ACTIVE : NAV_IDLE,
      )}
    >
      <link.icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 text-sm font-medium">
        {link.label}
      </span>
    </NavLink>
  );
}

export default function SpineRail({
  collapsed,
  onToggleCollapsed,
  stages,
  activeId,
  onStageNavigate,
}: Props) {
  const location = useLocation();
  const { selectedProfileId } = useProfileSelection();
  const utilityLinks = spineUtilityNavItems(selectedProfileId).map((item) => ({
    ...item,
    icon: UTILITY_ICONS[item.id],
    match: location.pathname === item.path,
  }));
  const workshopLinks = utilityLinks.filter((l) => WORKSHOP_IDS.includes(l.id));
  const supportLinks = utilityLinks.filter((l) => !WORKSHOP_IDS.includes(l.id));

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ease-out lg:flex print:hidden",
        collapsed ? "w-[4.25rem]" : "w-72",
      )}
    >
      <div className={cn("border-b border-border", collapsed ? "px-2 py-3" : "px-4 py-4")}>
        <div className={cn("flex items-center gap-2.5", collapsed && "justify-center")}>
          {collapsed ? (
            <LayeredSheetMark />
          ) : (
            <div className="flex min-w-0 items-center gap-2.5">
              <LayeredSheetMark className="h-9 w-9 shrink-0" />
              <div className="min-w-0">
                <div className="font-serif text-base font-semibold tracking-[-0.02em] text-foreground">
                  PrintPartner
                </div>
                <div className="text-3xs uppercase tracking-[0.12em] text-muted-foreground">
                  Print planning & production
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={cn("flex flex-1 flex-col gap-3 overflow-y-auto", collapsed ? "p-2" : "p-3")}>
        <GroupHeading collapsed={collapsed}>On the bench</GroupHeading>
        {!collapsed ? (
          <div className="desk-nameplate space-y-2 p-2">
            <PlanPicker className="w-full" />
            <CreatePlanButton className="w-full" variant="outline" size="sm" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <SidebarTooltip label="Switch plan" collapsed>
              <div className="mx-auto">
                <PlanPicker compact className="mx-auto" />
              </div>
            </SidebarTooltip>
            <SidebarTooltip label="New Build" collapsed>
              <CreatePlanButton size="icon" showLabel={false} variant="ghost" className="mx-auto" />
            </SidebarTooltip>
          </div>
        )}

        <WorkflowProgress
          stages={stages}
          activeId={activeId}
          collapsed={collapsed}
          onNavigate={onStageNavigate}
        />

        <GroupHeading collapsed={collapsed}>Workshop</GroupHeading>

        {/* Stage-weight utility rows (not desk-loop / WorkflowProgress). Flush via onStageNavigate. */}
        <nav
          className={cn("flex flex-col", collapsed && "gap-1")}
          aria-label="Utility"
        >
          {workshopLinks.map((link) => (
            <UtilityLink
              key={link.id}
              link={link}
              collapsed={collapsed}
              onStageNavigate={onStageNavigate}
            />
          ))}
        </nav>
      </div>

      <div className={cn("mt-auto space-y-1 border-t border-border", collapsed ? "p-2" : "p-3")}>
        <nav className={cn("flex flex-col", collapsed && "gap-1")} aria-label="Support">
          {supportLinks.map((link) => (
            <UtilityLink
              key={link.id}
              link={link}
              collapsed={collapsed}
              onStageNavigate={onStageNavigate}
            />
          ))}
        </nav>
        {!collapsed && (
          <SupportCta
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
          />
        )}

        <Button
          type="button"
          variant="ghost"
          size={collapsed ? "icon" : "sm"}
          className={cn("text-muted-foreground", !collapsed && "w-full justify-start")}
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4" />
              Collapse sidebar
            </>
          )}
        </Button>
      </div>
    </aside>
  );
}

import { type MouseEvent, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  BookOpen,
  Factory,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  Settings,
} from "lucide-react";
import CreatePlanButton from "../CreatePlanButton";
import PlanPicker from "../PlanPicker";
import SupportCta from "../SupportCta";
import ThemePreferenceControl from "../ThemePreferenceControl";
import WorkflowProgress from "../WorkflowProgress";
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
} from "../../lib/spineUtilityNav";
import { cn } from "../../lib/utils";
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
  production: Factory,
  printers: Printer,
  settings: Settings,
  help: BookOpen,
};

function LayeredSheetMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn("text-primary", className)}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      {/* Two offset 10×12 rounded rects — layered-sheet mark (not printer / not PP). */}
      <rect x="1" y="5" width="10" height="12" rx="2" fill="currentColor" opacity="0.45" />
      <rect x="7" y="2" width="10" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

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

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ease-out lg:flex print:hidden",
        collapsed ? "w-[4.25rem]" : "w-56",
      )}
    >
      <div className={cn("border-b border-border", collapsed ? "px-2 py-3" : "px-4 py-4")}>
        <div className={cn("flex items-center gap-2.5", collapsed && "justify-center")}>
          {collapsed ? (
            <LayeredSheetMark />
          ) : (
            <div
              className="font-serif text-[15px] font-semibold tracking-[-0.01em] text-foreground"
            >
              Print Partner
            </div>
          )}
        </div>
      </div>

      <div className={cn("flex flex-1 flex-col gap-3 overflow-y-auto", collapsed ? "p-2" : "p-3")}>
        {!collapsed ? (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2">
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

        <Separator className={cn(collapsed && "mx-1")} />

        {/* Stage-weight utility rows (not desk-loop / WorkflowProgress). Flush via onStageNavigate. */}
        <nav
          className={cn("flex flex-col", collapsed && "gap-1")}
          aria-label="Utility"
        >
          {utilityLinks.map((link) => {
            if (collapsed) {
              return (
                <SidebarTooltip key={link.id} label={link.label} collapsed>
                  <NavLink
                    to={link.to}
                    onClick={(e) => onStageNavigate(link.to, e)}
                    className={cn(
                      "relative flex items-center justify-center rounded-md p-2.5 transition-colors",
                      link.match
                        ? "bg-primary/12 text-primary"
                        : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
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
                key={link.id}
                to={link.to}
                onClick={(e) => onStageNavigate(link.to, e)}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
                  link.match
                    ? "bg-primary/12 text-primary"
                    : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                )}
              >
                <link.icon className="h-4 w-4 shrink-0" />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-[13px] font-medium",
                    link.match && "font-semibold",
                  )}
                >
                  {link.label}
                </span>
              </NavLink>
            );
          })}
        </nav>
      </div>

      <div className={cn("mt-auto space-y-2 border-t border-border", collapsed ? "p-2" : "p-3")}>
        {!collapsed && (
          <>
            <div className="px-1">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Theme</p>
              <ThemePreferenceControl compact className="w-full" />
            </div>
            <SupportCta
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
            />
          </>
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

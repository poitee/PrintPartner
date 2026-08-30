import { type MouseEvent, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  BookOpen,
  Factory,
  Layers,
  Library,
  Menu,
  Printer,
  Settings,
} from "lucide-react";
import CreatePlanButton from "../CreatePlanButton";
import PlanPicker from "../PlanPicker";
import SupportCta from "../SupportCta";
import ThemePreferenceControl from "../ThemePreferenceControl";
import LayeredSheetMark from "./BrandMark";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../ui/sheet";
import {
  spineUtilityNavItems,
  type SpineUtilityId,
} from "../../lib/spineUtilityNav";
import { cn } from "@/lib/utils";
import { useProfileSelection } from "../../context/ProfileContext";

const UTILITY_ICONS: Record<SpineUtilityId, typeof Layers> = {
  builds: Layers,
  library: Library,
  production: Factory,
  printers: Printer,
  settings: Settings,
  help: BookOpen,
};

const WORKSHOP_IDS: SpineUtilityId[] = ["builds", "library", "production", "printers"];

const NAV_RAIL =
  "relative before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:content-['']";
const NAV_ACTIVE = "bg-primary/12 font-semibold text-primary before:bg-primary";
const NAV_IDLE =
  "text-muted-foreground hover:bg-accent/70 hover:text-foreground before:bg-transparent";

type Props = {
  onNavigate: (to: string, e: MouseEvent<HTMLAnchorElement>) => void;
};

function DrawerGroupLabel({ children }: { children: string }) {
  return (
    <p className="px-1 font-mono text-3xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

/** Hamburger-triggered navigation drawer for viewports below lg (no SpineRail). */
export default function MobileNavDrawer({ onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const { selectedProfileId } = useProfileSelection();
  const items = spineUtilityNavItems(selectedProfileId).map((item) => ({
    ...item,
    icon: UTILITY_ICONS[item.id],
  }));
  const workshop = items.filter((i) => WORKSHOP_IDS.includes(i.id));
  const support = items.filter((i) => !WORKSHOP_IDS.includes(i.id));

  const renderLink = (item: (typeof items)[number]) => (
    <NavLink
      key={item.id}
      to={item.to}
      onClick={(e) => {
        setOpen(false);
        onNavigate(item.to, e);
      }}
      className={({ isActive }) =>
        cn(
          NAV_RAIL,
          "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
          isActive ? NAV_ACTIVE : NAV_IDLE,
        )
      }
      end
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {item.label}
    </NavLink>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 lg:hidden"
          aria-label="Menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="w-80 max-w-[85vw] gap-0 p-0"
      >
        <SheetHeader className="flex-row items-center gap-2.5 space-y-0 px-4 py-4">
          <LayeredSheetMark className="h-9 w-9" />
          <SheetTitle className="font-serif text-[15px] font-semibold tracking-[-0.01em]">
            PrintPartner
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
          <div className="space-y-2">
            <DrawerGroupLabel>On the bench</DrawerGroupLabel>
            <div className="desk-nameplate space-y-2 p-2">
              <PlanPicker className="w-full" />
              <CreatePlanButton className="w-full" variant="outline" size="sm" />
            </div>
          </div>
          <div className="space-y-2">
            <DrawerGroupLabel>Workshop</DrawerGroupLabel>
            <nav className="flex flex-col" aria-label="Workshop">
              {workshop.map(renderLink)}
            </nav>
          </div>
          <div className="space-y-2">
            <DrawerGroupLabel>Support</DrawerGroupLabel>
            <nav className="flex flex-col" aria-label="Support pages">
              {support.map(renderLink)}
            </nav>
          </div>
        </div>
        <div className="space-y-2 border-t border-border p-3">
          <ThemePreferenceControl compact className="w-full" />
          <SupportCta
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

import { Plus } from "lucide-react";
import { Button } from "./ui/button";
import { usePlanActions } from "../context/PlanActionsContext";
import { cn } from "../lib/utils";

type Props = {
  variant?: "default" | "secondary" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  showLabel?: boolean;
};

/** Opens the spine plan picker's create dialog. */
export default function CreatePlanButton({
  variant = "secondary",
  size = "sm",
  className,
  showLabel = true,
}: Props) {
  const { openCreatePlan } = usePlanActions();
  const iconOnly = size === "icon";

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn("shrink-0", className)}
      onClick={openCreatePlan}
      aria-label="New Build"
    >
      <Plus className={cn("h-4 w-4", showLabel && !iconOnly && "mr-1.5")} />
      {showLabel && !iconOnly ? "New Build" : null}
    </Button>
  );
}

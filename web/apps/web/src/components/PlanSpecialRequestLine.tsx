import { cn } from "@/lib/utils";
import { useOrdersVisible } from "../hooks/useOrdersVisible";

type Props = {
  profileId: number | null | undefined;
  note: string | null | undefined;
  className?: string;
};

/** Quiet Progress readout of the plan special-request note. Hidden when Orders is off. */
export default function PlanSpecialRequestLine({ profileId, note, className }: Props) {
  const ordersVisible = useOrdersVisible(profileId);
  const text = note?.trim();
  if (!ordersVisible || !text) return null;
  return (
    <p
      className={cn("text-sm text-muted-foreground", className)}
      data-testid="plan-special-request-line"
    >
      {text}
    </p>
  );
}

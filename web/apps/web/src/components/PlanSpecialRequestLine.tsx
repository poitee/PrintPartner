import { cn } from "../lib/utils";

type Props = {
  note: string | null | undefined;
  className?: string;
};

/** Quiet Progress readout of the plan special-request note. */
export default function PlanSpecialRequestLine({ note, className }: Props) {
  const text = note?.trim();
  if (!text) return null;
  return (
    <p
      className={cn("text-sm text-muted-foreground", className)}
      data-testid="plan-special-request-line"
    >
      {text}
    </p>
  );
}

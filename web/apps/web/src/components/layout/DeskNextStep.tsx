import { cn } from "../../lib/utils";

type Props = {
  children: string | null | undefined;
  className?: string;
};

/** One quiet next-step line under a spine page header (GRE-226). */
export default function DeskNextStep({ children, className }: Props) {
  if (!children) return null;
  return (
    <p
      className={cn(
        "text-[12.5px] leading-snug text-muted-foreground",
        className,
      )}
      data-testid="desk-next-step"
    >
      {children}
    </p>
  );
}

import { cn } from "@/lib/utils";

type Props = {
  children: string | null | undefined;
  className?: string;
};

export default function DeskNextStep({ children, className }: Props) {
  if (!children) return null;
  return (
    <p
      className={cn(
        "text-body leading-snug text-muted-foreground",
        className,
      )}
      data-testid="desk-next-step"
    >
      {children}
    </p>
  );
}
